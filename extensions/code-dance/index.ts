/**
 * pi-code-dance — performs the agent's output in time with the music.
 *
 * Pi has no API to replace the assistant message renderer and none to hold the
 * token stream back, so the extension uses the two levers it does have:
 *
 * 1. A markdown transformer stands in for the prose and the reasoning Pi is
 *    about to draw. A part still streaming shows `打印中`; once the message is
 *    final, only a part that actually reached the queue is replaced. That record
 *    lives in this process and is dropped the moment the task's performance ends,
 *    so a session restored later — or the transcript after the hand-back — shows
 *    the real text.
 * 2. A widget above the editor performs the queue on the onsets of a MIDI track
 *    while its `.wav` plays beside it. It is mounted with the task's first
 *    output and taken down when the performance ends, so an idle screen has no
 *    stage on it.
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
import { ExpansionMirror } from "./expansion.ts";
import { OutputFeed } from "./feed.ts";
import type { Track } from "./library.ts";
import { bundledMusicDir, collectTracks, userMusicDir } from "./library.ts";
import { partKey, playedNotice, printingNotice, toolCallText } from "./parts.ts";
import { registerSettingsCommand } from "./settings.ts";
import type { Stage } from "./stage.ts";
import { installStage } from "./stage.ts";

const WIDGET_KEY = "code-dance";
/** The footer marker; a key space of its own, shared with nothing. */
const STATUS_KEY = "code-dance";

/** The stage's view before a track starts. */
const IDLE_VIEW: StageView = {
	title: "",
	bpm: 0,
	elapsed: 0,
	duration: 0,
	mode: "sequential",
	energy: 0,
	pulse: 0,
};

export default function codeDance(pi: ExtensionAPI): void {
	const feed = new OutputFeed();
	/** Keys of the parts whose text went through the queue: what may be replaced. */
	const staged = new Set<string>();
	const mirror = new ExpansionMirror(() => lastCtx?.ui);

	let lastCtx: ExtensionContext | undefined;
	/** The task in progress is being performed — the transformer stands in for its text. */
	let performing = false;
	/** The rest of this task is not performed — `ctrl+shift+d` was pressed. */
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

	/** Keep the mirror on the printed position; the engine calls this on every strike. */
	function refresh(): void {
		if (engine) mirror.sync(engine.queue.printed.length);
		stage?.requestRender();
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
		staged.clear();
		feed.reset();
		mirror.clear();
		if (wasPerforming) stage?.repaint();
		hideStage();
	}

	/** Text into the queue. Nothing is output when there is nothing to print. */
	function perform(text: string, whole = false): void {
		if (text === "" || skipped || failed) return;
		performing = true;
		showStage();
		engine?.feed(text, whole);
	}

	function startStage(ui: ExtensionUIContext): Stage {
		return installStage(ui, WIDGET_KEY, {
			view: () => engine?.view ?? IDLE_VIEW,
			text: () => engine?.queue.printed ?? "",
			height: () => config.stageHeight,
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
		ui.setStatus(STATUS_KEY, config.enabled ? ui.theme.fg("accent", "♪ 演出模式") : undefined);
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
				musicSyncOffsetMs: config.musicSyncOffsetMs,
				backend,
			});
		}
		if (enabledChanged) rearm();
		updateStatus();
		stage?.requestRender();
	}

	function resetState(): void {
		feed.reset();
		staged.clear();
		mirror.clear();
		performing = false;
		skipped = false;
		failed = false;
	}

	// What Pi asks the transformer for: the prose of a message and each run of
	// reasoning, exactly as `OutputFeed` reproduces it on the way in.
	pi.registerMarkdownTransformer((markdown, context) => {
		if (!performing || context.messageType === "user" || !config.showPlaceholder) return markdown;
		if (context.isStreaming) return printingNotice(markdown);
		return staged.has(partKey(markdown)) ? playedNotice(markdown) : markdown;
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
		const update = event.assistantMessageEvent;
		if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") return;
		for (const chunk of feed.push(update)) perform(chunk.text, chunk.whole);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		// From here the transformer answers from this set: the parts whose text went
		// through the queue are the ones the stage has performed.
		for (const key of feed.takePartKeys()) staged.add(key);
	});

	pi.on("tool_execution_start", async (event) => {
		if (!engine) return;
		// The span that keeps the block open starts at the call's line, before the
		// line itself is queued — the block is the record of the tool being run.
		mirror.open(event.toolCallId, engine.queue.total);
		perform(toolCallText(event.toolName, event.args, engine.queue.tail));
	});

	pi.on("tool_result", async (event) => {
		if (!engine) return;
		// An image result is nothing to perform — and no reason to fold anything.
		const text = event.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (text !== "") perform(text);
		mirror.close(event.toolCallId, engine.queue.total);
	});

	pi.on("agent_settled", async () => {
		engine?.onTaskSettled();
	});

	pi.on("before_provider_request", async () => {
		// Handlers are awaited, so this is a gate: the request waits here while the
		// printing is far behind, and is let go once it has caught up.
		await engine?.waitForCapacity();
	});

	pi.registerShortcut("ctrl+shift+d", {
		description: "CodeDance: print the rest of the queue and stop the music",
		handler: async () => {
			// The flush hands the text back on its own; the task is not performed any
			// further, so the rest of it renders as it always would.
			skipped = true;
			engine?.flush();
		},
	});

	registerSettingsCommand(pi, {
		getConfig: () => config,
		getTrackCount: () => tracks.length,
		onConfigChanged: applyConfig,
	});
}
