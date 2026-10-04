/**
 * pi-code-dance — performs the agent's output in time with the music.
 *
 * Pi has no API to replace the assistant message renderer and none to hold the
 * token stream back, so the extension uses the three levers it does have:
 *
 * 1. A markdown transformer stands in for the prose and the reasoning Pi is
 *    about to draw, until each part has actually been performed. A part still
 *    streaming shows `printing`; once the message is final, a part still in the
 *    queue shows `performing`, and the moment the printing passes where the part
 *    ends the transcript is repainted and shows the real text. So the transcript
 *    fills in piece by piece as the music plays, not all at the end. The record
 *    lives in this process and is dropped the moment the task's performance ends,
 *    so a session restored later — or the transcript after the hand-back — shows
 *    the real text.
 * 2. The built-in tools are registered again with their renderers wrapped
 *    (`toolhold.ts`), which holds a tool's block — the call line while it
 *    streams and runs, the result once it lands — behind the same notice, and
 *    hands each the real renderer the moment its text is on the stage. This is
 *    the transformer's trick applied where markdown never reaches.
 * 3. A widget above the editor performs the queue on the onsets of a MIDI track
 *    while its `.wav` plays beside it. It is mounted with the task's first
 *    output and taken down when the performance ends, so an idle screen has no
 *    stage on it. While the queue is dry the panel names what it is waiting on —
 *    the running tool and its seconds, or the model — so a wait never reads as
 *    a stop. `ctrl+alt+p` holds the performance where it stands and lets it go
 *    on again: the hold is the engine's — player cut, beats cancelled, clock
 *    frozen — while the printing steps out of the music's way and runs at Pi's
 *    own pace until the beats come back.
 *
 * The queue runs *ahead* of the music: prose and reasoning deltas are enqueued as
 * they stream, a tool call's line from `tool_execution_start` (the transformer
 * never sees a call), and a tool result's text from `tool_result` — a handler
 * that only observes, because returning anything there would replace the result
 * itself, the copy the model reads.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { AudioBackend } from "./audio.ts";
import { createAudioBackend } from "./audio.ts";
import type { CodeDanceConfig } from "./config.ts";
import { DEFAULT_CONFIG, ensureConfigFile, loadConfig, saveConfig } from "./config.ts";
import type { StageView } from "./engine.ts";
import { BeatEngine } from "./engine.ts";
import type { SealedUnit } from "./feed.ts";
import { OutputFeed } from "./feed.ts";
import { selfKillReason } from "./guard.ts";
import type { Track } from "./library.ts";
import { bundledMusicDir, collectTracks, trackTitle, userMusicDir } from "./library.ts";
import { callLine, partKey, printingNotice, stagedNotice, toolCallText } from "./parts.ts";
import { registerSettingsCommand } from "./settings.ts";
import type { Stage } from "./stage.ts";
import { installStage } from "./stage.ts";
import { ToolHold, overrideBuiltInTools, resultText } from "./toolhold.ts";

const WIDGET_KEY = "code-dance";
/** The footer marker; a key space of its own, shared with nothing. */
const STATUS_KEY = "code-dance";

/**
 * The transcript repaints whole — every mounted component re-renders and asks
 * its transformer again — so a swap waits at least this long after the previous
 * one. The frame loop asks again until the swap has happened.
 */
const REPAINT_MS = 300;

/**
 * How long the queue may stand empty before the panel names the wait. Brief dry
 * gaps — between deltas, between parts — are how the music breathes, and the
 * meter already speaks for them; only a wait that outlasts them is worth a line
 * of its own.
 */
const IDLE_STILL_MS = 700;

/** The stage's view before a track starts. */
const IDLE_VIEW: StageView = {
	title: "",
	bpm: 0,
	elapsed: 0,
	duration: 0,
	mode: "sequential",
	energy: 0,
	pulse: 0,
	paused: false,
};

export default function codeDance(pi: ExtensionAPI): void {
	const feed = new OutputFeed();
	/** Where a performed part ends in the queue, by key: the transformer swaps it back past this point. */
	const partEnds = new Map<string, number>();
	/** Where the units still streaming will end, by unit id — resolved into `partEnds` when they seal. */
	const unitEnd = new Map<number, number>();
	/** The tool blocks are the renderers' business, so the hold is what the tool events talk to. */
	const hold = new ToolHold({
		printed: () => engine?.queue.printed.length ?? 0,
		enabled: () => config.enabled && config.showPlaceholder,
	});

	/** The queue position the last crossing check was made from. */
	let seenPrinted = 0;
	/** A swap has happened in the queue and waits for its repaint. */
	let repaintDue = false;
	let repaintAt = 0;
	/** Tool calls still running, in the order they started: the first names the activity row. */
	const running = new Map<string, { line: string; since: number }>();
	/** When the queue last went dry; 0 while it has anything to print. */
	let idleSince = 0;

	let lastCtx: ExtensionContext | undefined;
	/** The task in progress is being performed — the transformer stands in for its text. */
	let performing = false;
	/** The rest of this task is not performed — `ctrl+alt+d` was pressed. */
	let skipped = false;
	/** This task's performance broke down — a track that would not play — and is off. */
	let failed = false;
	let config: CodeDanceConfig = { ...DEFAULT_CONFIG };
	let agentDir = "";
	let tracks: readonly Track[] = [];
	let backend: AudioBackend | undefined;
	let engine: BeatEngine | undefined;
	let stage: Stage | undefined;

	function notify(message: string, level: "info" | "warning" | "error"): void {
		lastCtx?.ui.notify(message, level);
	}

	/**
	 * Keep the stage and the transcript on the printed position; the engine calls
	 * this on every strike and on every frame. The stage follows the queue
	 * directly, but the transcript is swapped only when the printing has passed
	 * where a part ends — a whole repaint, so the swaps are throttled; the frame
	 * loop asks again until a waiting one has happened.
	 */
	function refresh(): void {
		if (!engine) return;
		stage?.requestRender();

		// The dry clock runs from the first frame of an empty queue; a frame with
		// something to print stops it.
		if (engine.queue.isEmpty) {
			if (idleSince === 0) idleSince = Date.now();
		} else {
			idleSince = 0;
		}

		const printed = engine.queue.printed.length;
		if (printed !== seenPrinted) {
			if (crossed(seenPrinted, printed)) repaintDue = true;
			seenPrinted = printed;
		}
		if (!repaintDue) return;

		const now = Date.now();
		if (now < repaintAt) return;
		repaintAt = now + REPAINT_MS;
		repaintDue = false;
		stage?.repaint();
	}

	/** Something the transcript is showing as a notice ended inside the queue's latest step. */
	function crossed(previous: number, printed: number): boolean {
		for (const end of partEnds.values()) if (previous < end && end <= printed) return true;
		return hold.crossed(previous, printed);
	}

	/** A unit left the stream: from here the key, not the id, is what the transformer asks by. */
	function settleUnit(unit: SealedUnit): void {
		const end = unitEnd.get(unit.unit);
		unitEnd.delete(unit.unit);
		if (end !== undefined) partEnds.set(unit.key, end);
	}

	/**
	 * The performance of a task ends: the stage comes down and the transcript
	 * renders the real text again, because the parts are forgotten. An old message
	 * repainted later cannot then be replaced by a notice for text that is no
	 * longer on the stage.
	 */
	function handBack(): void {
		const wasPerforming = performing;
		performing = false;
		partEnds.clear();
		unitEnd.clear();
		seenPrinted = 0;
		repaintDue = false;
		running.clear();
		idleSince = 0;
		feed.reset();
		hold.clear();
		if (wasPerforming) stage?.repaint();
		hideStage();
	}

	/**
	 * Text into the queue. Nothing is output when there is nothing to print, and
	 * the caller hears about it — the queue's span of a part is recorded from
	 * what actually went in.
	 */
	function perform(text: string, whole = false): boolean {
		if (text === "" || skipped || failed || !config.enabled) return false;
		if (!engine?.feed(text, whole)) return false;
		performing = true;
		showStage();
		return true;
	}

	/**
	 * The line under the meter while the queue is dry: what the performance is
	 * waiting on, named — a tool still running, with its seconds, or the model
	 * itself. Empty hides the row, so the text keeps every row the panel has the
	 * rest of the time. A held performance keeps the row whatever the queue is
	 * doing — the music is what waits, and the row names the way back.
	 */
	function activity(): string {
		if (!engine || !performing) return "";
		if (engine.isPaused) return "⏸ 已暂停 · 打印照常 · ctrl+alt+p 继续";
		if (!engine.queue.isEmpty) return "";
		const now = Date.now();
		if (idleSince === 0 || now - idleSince < IDLE_STILL_MS) return "";
		const first = running.values().next().value;
		if (first) return `⏳ ${first.line} · ${Math.floor((now - first.since) / 1000)}s`;
		return "⏳ waiting for the model…";
	}

	function startStage(ui: ExtensionUIContext): Stage {
		return installStage(ui, WIDGET_KEY, {
			view: () => engine?.view ?? IDLE_VIEW,
			text: () => engine?.queue.printed ?? "",
			height: () => config.stageHeight,
			activity,
		});
	}

	/**
	 * The stage exists only while a task is being performed: it is mounted on the
	 * task's first output and unmounted when the performance ends, so it never
	 * takes rows from the transcript just to sit there waiting.
	 */
	function showStage(): void {
		if (!config.enabled || !lastCtx?.ui || stage) return;
		stage = startStage(lastCtx.ui);
	}

	function hideStage(): void {
		stage?.dispose();
		stage = undefined;
	}

	/** The footer marker: there while the performance is armed, absent when it is not. */
	function updateStatus(): void {
		if (!lastCtx || lastCtx.mode !== "tui") return;
		const ui = lastCtx.ui;
		ui.setStatus(STATUS_KEY, config.enabled ? ui.theme.fg("accent", "♪ performance mode") : undefined);
	}

	function clearStatus(): void {
		if (lastCtx?.mode === "tui") lastCtx.ui.setStatus(STATUS_KEY, undefined);
	}

	/** The performance is switched on or off: stage, engine and transcript follow. */
	function rearm(): void {
		engine?.setEnabled(config.enabled);
		if (config.enabled) return;
		engine?.reset();
		handBack();
	}

	/** A change from the panel: it takes effect now, and is written down. */
	function applyConfig(next: CodeDanceConfig): void {
		const backendChanged = next.audioBackend !== config.audioBackend || next.audioCommand !== config.audioCommand;
		const enabledChanged = next.enabled !== config.enabled;
		const placeholderChanged = next.showPlaceholder !== config.showPlaceholder;
		config = next;
		saveConfig(agentDir, config);

		if (backendChanged && backend) {
			backend.stop();
			backend = createAudioBackend(config.audioBackend, config.audioCommand);
		}
		if (engine && backend) {
			engine.configure({
				tracks,
				mode: config.playlistMode,
				loopTrack: config.loopTrack,
				musicSyncOffsetMs: config.musicSyncOffsetMs,
				backend,
			});
		}
		if (enabledChanged) rearm();
		// The placeholders go up and down with the setting: the transcript repaints either way.
		if (placeholderChanged) stage?.repaint();
		updateStatus();
		stage?.requestRender();
	}

	function resetState(): void {
		feed.reset();
		partEnds.clear();
		unitEnd.clear();
		seenPrinted = 0;
		repaintDue = false;
		running.clear();
		idleSince = 0;
		hold.clear();
		performing = false;
		skipped = false;
		failed = false;
	}

	// What Pi asks the transformer for: the prose of a message and each run of
	// reasoning, exactly as `OutputFeed` reproduces it on the way in.
	pi.registerMarkdownTransformer((markdown, context) => {
		if (!performing || context.messageType === "user" || !config.showPlaceholder) return markdown;
		if (context.isStreaming) return printingNotice(markdown);
		// A part that reached the queue but has not been printed to its end yet is
		// the only one standing in; once the printing passes the end, the real text
		// is back — the repaint that asks again is what fires at the crossing.
		const end = partEnds.get(partKey(markdown));
		if (end === undefined) return markdown;
		return end <= (engine?.queue.printed.length ?? 0) ? markdown : stagedNotice(markdown);
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// The performance needs a terminal and a transcript; in any other mode the
		// extension stays out of the way instead of printing one into stdout.
		if (ctx.mode !== "tui") return;

		agentDir = getAgentDir();
		ensureConfigFile(agentDir);
		config = loadConfig(agentDir, notify);
		tracks = collectTracks([bundledMusicDir(), userMusicDir(agentDir)]);
		updateStatus();

		hideStage();
		engine?.stop();
		backend?.stop();
		backend = createAudioBackend(config.audioBackend, config.audioCommand);
		engine = new BeatEngine({
			tracks,
			mode: config.playlistMode,
			loopTrack: config.loopTrack,
			musicSyncOffsetMs: config.musicSyncOffsetMs,
			backend,
			onView: refresh,
			onError: (message) => {
				notify(message, "warning");
				// A track that will not open or play is no reason to keep performing:
				// what this task already queued is dropped with the stage.
				failed = true;
				engine?.queue.reset();
				handBack();
			},
			onHandBack: handBack,
		});
		resetState();
		engine.setEnabled(config.enabled);

		// The transcript's tool blocks are drawn by the tools' own renderers, so
		// the built-ins are registered again — wrapped — for this session.
		overrideBuiltInTools(pi, hold, { cwd: ctx.cwd, agentDir, trusted: ctx.isProjectTrusted() });
	});

	pi.on("session_shutdown", async () => {
		engine?.stop();
		engine = undefined;
		backend?.stop();
		backend = undefined;
		hideStage();
		resetState();
		clearStatus();
		lastCtx = undefined;
	});

	pi.on("agent_start", async () => {
		if (!engine) return;
		skipped = false;
		failed = false;
		engine.onTaskStart();
	});

	pi.on("message_start", async (event) => {
		if (!engine || event.message.role !== "assistant") return;
		feed.reset();
	});

	pi.on("message_update", async (event) => {
		if (!engine || event.message.role !== "assistant") return;
		// A tool call is drawn from the moment it appears in the streaming message —
		// before its line has reached the queue — so its block is held from here.
		for (const block of event.message.content) {
			if (block.type === "toolCall") hold.expect(block.id);
		}
		const update = event.assistantMessageEvent;
		if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") return;
		const { chunks, sealed } = feed.push(update);
		for (const unit of sealed) settleUnit(unit);
		for (const chunk of chunks) {
			// Where the unit would end if this chunk is its last: the queue's total
			// grows by exactly the chunk's length, so the end can be read before it
			// is taken — and only stands if the engine takes it.
			const end = engine.queue.total + chunk.text.length;
			if (perform(chunk.text, chunk.whole)) unitEnd.set(chunk.unit, end);
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		// From here the transformer answers by part key: a part not in `partEnds`
		// never reached the queue and renders as it always would.
		for (const unit of feed.takeSealed()) settleUnit(unit);
	});

	pi.on("tool_execution_start", async (event) => {
		if (!engine) return;
		// The call's line goes into the queue and the block is bound to it: the
		// span the block is held for ends where the line ends.
		const text = toolCallText(event.toolName, event.args, engine.queue.tail);
		const end = engine.queue.total + text.length;
		if (perform(text)) {
			hold.open(event.toolCallId, end);
			// If the queue drains while the tool still runs, the activity row names it.
			running.set(event.toolCallId, { line: callLine(event.toolName, event.args), since: Date.now() });
		}
	});

	pi.on("tool_result", async (event) => {
		if (!engine) return;
		running.delete(event.toolCallId);
		// Where the result's text ends, read off before it is queued; 0 marks a
		// result the stage will not print — nothing to wait for.
		const text = resultText(event);
		const end = engine.queue.total + text.length;
		hold.close(event.toolCallId, text !== "" && perform(text) ? end : 0);
	});

	pi.on("tool_call", async (event) => {
		// A command that kills by the image name `node` kills pi with it; the
		// guard refuses those and says how to kill just the one process instead.
		// It stands in every mode and with the performance off: what it protects
		// is the session, not the show.
		const reason = selfKillReason(event.toolName, event.input);
		return reason === undefined ? undefined : { block: true, reason };
	});

	pi.on("agent_settled", async () => {
		engine?.onTaskSettled();
	});

	pi.on("before_provider_request", async () => {
		// Handlers are awaited, so this is a gate: the request waits here while the
		// printing is far behind, and is let go once it has caught up.
		await engine?.waitForCapacity();
	});

	pi.registerShortcut("ctrl+alt+d", {
		description: "CodeDance: print the rest of the queue and stop the music",
		handler: async () => {
			// The flush hands the text back on its own; the task is not performed any
			// further, so the rest of it renders as it always would.
			skipped = true;
			engine?.flush();
		},
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "CodeDance: hold the performance, or let it go on",
		handler: async () => {
			if (!engine) return;
			// A held performance can be let go only by the same key: the notice says
			// which way it went. A press with nothing playing is silent — and so is
			// the one whose printing drains a settled queue, because that is the
			// performance ending, not holding.
			if (engine.isPaused) {
				engine.resume();
				notify("♪ 演出继续", "info");
			} else if (engine.pause()) {
				notify("♪ 演出已暂停 · 打印照常", "info");
			}
		},
	});

	registerSettingsCommand(pi, {
		getConfig: () => config,
		getTrackNames: () => tracks.map((track) => trackTitle(track.midi)),
		onConfigChanged: applyConfig,
	});
}
