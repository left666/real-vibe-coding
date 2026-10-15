/**
 * Holds a tool's transcript block behind a stage notice until the stage has
 * performed it.
 *
 * Pi draws a tool's block from the moment its call streams into the message —
 * before the tool runs — and no API says "not yet". But a block is drawn by
 * its tool's own renderers, and a definition can be registered again under the
 * same name. So each built-in tool is registered with wrappers around its
 * renderers: while the call line or the result text is still on its way to the
 * stage, the wrapper answers with the same one-line notice the markdown
 * transformer uses for prose; once the printing has passed where the block's
 * text ends, the wrapper delegates to the real renderer and the block returns
 * to its usual look. A call block that draws a preview of the work itself — a
 * write's text, an edit's diff — waits for the work, not merely its line: the
 * preview is the work again, and showing it early would hand the transcript
 * what the stage has not performed yet.
 *
 * Queue positions are what the rest of the extension already tracks: `open`
 * marks where a call's line ends, `close` where the result's text ends (or that
 * there is none), `printed` is how far the stage has printed, and `crossed`
 * tells the caller when a held block became showable — the moment a repaint is
 * worth its cost.
 *
 * Pure: no Pi, no timers. Only the registration talks to the API, and it
 * touches nothing until a tool block is drawn.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as piModule from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";

import { callLine, printingCall, printingNotice, stagedCall, stagedNotice } from "./parts.ts";

/** What a tool block should draw right now. */
export type BlockState =
	/** The block's text is printed: the real renderer draws it. */
	| "shown"
	/** The text is not in the queue yet — still streaming towards the stage. */
	| "printing"
	/** The text is queued but not yet fully printed. */
	| "staged";

/** Where a held tool's text ends in the queue. */
interface Hold {
	/** The queue length once the call's line was enqueued. */
	callEnd: number;
	/** Where the result's text ends; 0 when there is nothing to wait for; null while the tool still runs. */
	resultEnd: number | null;
	/** The call block draws a preview of the work itself: it waits for the work, not just the line. */
	workPreview: boolean;
}

/**
 * The tools whose call block draws a preview of the work itself — the text a
 * write puts down, the diff an edit works out. The preview is derived from the
 * same arguments the stage takes the work from, so revealing it early would
 * show text the music has not performed.
 */
const WORK_PREVIEWS: ReadonlySet<string> = new Set(["write", "edit"]);

/** No reveal point: the block waits on work that has not been queued yet. */
const UNREVEALED = Number.POSITIVE_INFINITY;

/**
 * Where a call block's wait ends. Usually where its line ends. A block that
 * previews the work waits for the work instead: unrevealed while the tool
 * still runs, back to the line's end when the result performed nothing, and
 * where the work ends when it did.
 */
function callReveal(hold: Hold): number {
	if (!hold.workPreview) return hold.callEnd;
	if (hold.resultEnd === null) return UNREVEALED;
	return hold.resultEnd === 0 ? hold.callEnd : hold.resultEnd;
}

export interface HoldPorts {
	/** Characters the stage has printed. */
	printed(): number;
	/** The stand-in is on: content is performed, and notices stand in for it. */
	enabled(): boolean;
}

export class ToolHold {
	private readonly ports: HoldPorts;
	private readonly holds = new Map<string, Hold>();
	/** Calls whose block is in the transcript but whose line is not in the queue yet. */
	private readonly pending = new Set<string>();

	constructor(ports: HoldPorts) {
		this.ports = ports;
	}

	/** A tool call appeared in the streaming message: its block is held from this moment. */
	expect(id: string): void {
		if (!this.ports.enabled()) return;
		this.pending.add(id);
	}

	/** The call's line is in the queue, ending at `callEnd`; the tool's name decides how long the block is held. */
	open(id: string, callEnd: number, name: string): void {
		this.pending.delete(id);
		if (!this.ports.enabled()) return;
		this.holds.set(id, { callEnd, resultEnd: null, workPreview: WORK_PREVIEWS.has(name) });
	}

	/**
	 * Nothing more will be queued for the tool. `resultEnd` is where its text
	 * ends, or 0 when there is none. Returns true when this close is what
	 * revealed the call block — a previewing block whose work performed
	 * nothing: `crossed` only sees printing steps, and this reveal has none.
	 */
	close(id: string, resultEnd: number): boolean {
		this.pending.delete(id);
		const hold = this.holds.get(id);
		if (!hold) return false;
		const revealed = hold.workPreview && resultEnd === 0 && this.ports.printed() >= hold.callEnd;
		hold.resultEnd = resultEnd;
		return revealed;
	}

	/** What the call block should draw. */
	callState(id: string): BlockState {
		if (!this.ports.enabled()) return "shown";
		const hold = this.holds.get(id);
		if (!hold) return this.pending.has(id) ? "printing" : "shown";
		return this.ports.printed() >= callReveal(hold) ? "shown" : "staged";
	}

	/** What the result block should draw. */
	resultState(id: string, isPartial: boolean): BlockState {
		if (!this.ports.enabled()) return "shown";
		const hold = this.holds.get(id);
		if (!hold) return "shown";
		const end = hold.resultEnd;
		// The text is not in the queue yet: the tool still runs, or the result is
		// still streaming. Nothing of it can have been printed.
		if (end === null || isPartial) return "printing";
		if (end === 0) return "shown";
		return this.ports.printed() >= end ? "shown" : "staged";
	}

	/** A held block ended inside the queue's latest step: worth a repaint. */
	crossed(previous: number, printed: number): boolean {
		for (const hold of this.holds.values()) {
			const reveal = callReveal(hold);
			if (previous < reveal && reveal <= printed) return true;
			const end = hold.resultEnd;
			if (end !== null && end !== 0 && previous < end && end <= printed) return true;
		}
		return false;
	}

	/** The performance is over: every block draws itself again. */
	clear(): void {
		this.holds.clear();
		this.pending.clear();
	}
}

interface ResultBlock {
	type: string;
	text?: string;
}

/** What a result offers the policy below: its text blocks, and whatever details the tool attached. */
interface ResultLike {
	readonly content: readonly ResultBlock[];
	readonly details?: unknown;
}

/** A string argument of a tool call, or null when the call did not carry one. */
function argumentText(args: unknown, key: string): string | null {
	const fields = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
	const value = fields?.[key];
	return typeof value === "string" ? value : null;
}

/** The diff an edit worked out, or null when the result carries none. */
function diffText(details: unknown): string | null {
	const diff = (details as { diff?: unknown } | undefined)?.diff;
	return typeof diff === "string" ? diff : null;
}

/** The text blocks of a result, joined the way Pi joins them. */
function textBlocks(result: ResultLike): string {
	const texts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
	}
	return texts.join("\n");
}

/**
 * What the stage is asked to perform of a tool result.
 *
 * The result's own text usually is that: the blocks it carries, joined. Three
 * tools differ. A `read` is asked for nothing — what it brought in is input,
 * not output. `write` and `edit` hand back a one-line receipt, and the stage
 * performs the work instead of the receipt: the text a write put down, the diff
 * an edit worked out. A receipt with the work missing — an error's message, a
 * result shape that carries none — is performed as it is.
 */
export function resultText(toolName: string, args: unknown, result: ResultLike, isError: boolean): string {
	if (toolName === "read") return "";
	if (!isError && toolName === "write") {
		const content = argumentText(args, "content");
		if (content !== null) return content;
	}
	if (!isError && toolName === "edit") {
		const diff = diffText(result.details);
		if (diff !== null) return diff;
	}
	return textBlocks(result);
}

type AnyDefinition = ToolDefinition<any, any, any>;
type CallRenderer = NonNullable<AnyDefinition["renderCall"]>;
type ResultRenderer = NonNullable<AnyDefinition["renderResult"]>;

function placeholder(theme: Parameters<CallRenderer>[1], text: string): Component {
	return new Text(theme.fg("dim", text), 0, 0);
}

function wrapCall(render: CallRenderer, name: string, hold: ToolHold): CallRenderer {
	return (args, theme, context) => {
		const state = hold.callState(context.toolCallId);
		if (state === "shown") return render(args, theme, context);
		const line = callLine(name, args);
		return placeholder(theme, state === "printing" ? printingCall(line) : stagedCall(line));
	};
}

function wrapResult(render: ResultRenderer, name: string, hold: ToolHold): ResultRenderer {
	return (result, options, theme, context) => {
		const text = resultText(name, context.args, result, context.isError);
		if (text !== "") {
			const state = hold.resultState(context.toolCallId, options.isPartial);
			if (state !== "shown") {
				return placeholder(theme, state === "printing" ? printingNotice(text) : stagedNotice(text));
			}
		}
		return render(result, options, theme, context);
	};
}

/** The definition with its renderers wrapped; the definition itself when there is nothing to wrap. */
function holdDefinition(definition: AnyDefinition, hold: ToolHold): AnyDefinition {
	const call = definition.renderCall;
	const result = definition.renderResult;
	if (!call && !result) return definition;
	return {
		...definition,
		renderCall: call ? wrapCall(call, definition.name, hold) : call,
		renderResult: result ? wrapResult(result, definition.name, hold) : result,
	};
}

/** The built-in tools whose blocks are held, and the factory each definition is built from. */
const BUILT_INS: ReadonlyArray<readonly [string, string]> = [
	["read", "createReadToolDefinition"],
	["bash", "createBashToolDefinition"],
	["powershell", "createPowerShellToolDefinition"],
	["edit", "createEditToolDefinition"],
	["write", "createWriteToolDefinition"],
	["grep", "createGrepToolDefinition"],
	["find", "createFindToolDefinition"],
	["ls", "createLsToolDefinition"],
];

type Factory = (cwd: string, options?: Record<string, unknown>) => AnyDefinition;

export interface OverrideOptions {
	cwd: string;
	agentDir: string;
	/** The project's settings take part only in a trusted project. */
	trusted: boolean;
}

/**
 * Register the built-in tools again, wrapped. Each is rebuilt here from the
 * settings the session reads its own from, so the tool behind the wrapper
 * executes exactly as it did. A tool the running Pi does not have — 0.81 has
 * no powershell factory — and a definition with no renderers have nothing to
 * wrap, and are left alone.
 */
export function overrideBuiltInTools(pi: ExtensionAPI, hold: ToolHold, options: OverrideOptions): void {
	const settings = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: options.trusted });
	const exported = piModule as unknown as Record<string, unknown>;

	for (const [name, factoryName] of BUILT_INS) {
		const factory = exported[factoryName];
		if (typeof factory !== "function") continue;
		const base = (factory as Factory)(options.cwd, factoryOptions(name, settings));
		if (!base) continue;
		const wrapped = holdDefinition(base, hold);
		if (wrapped === base) continue;
		pi.registerTool(wrapped);
	}
}

function factoryOptions(name: string, settings: SettingsManager): Record<string, unknown> | undefined {
	if (name === "read") return { autoResizeImages: settings.getImageAutoResize() };
	if (name === "bash") return { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() };
	return undefined;
}
