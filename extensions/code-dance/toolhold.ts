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
 * to its usual look.
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

	/** The call's line is in the queue, ending at `callEnd`. */
	open(id: string, callEnd: number): void {
		this.pending.delete(id);
		if (!this.ports.enabled()) return;
		this.holds.set(id, { callEnd, resultEnd: null });
	}

	/** Nothing more will be queued for the tool. `resultEnd` is where its text ends, or 0 when there is none. */
	close(id: string, resultEnd: number): void {
		this.pending.delete(id);
		const hold = this.holds.get(id);
		if (hold) hold.resultEnd = resultEnd;
	}

	/** What the call block should draw. */
	callState(id: string): BlockState {
		if (!this.ports.enabled()) return "shown";
		const hold = this.holds.get(id);
		if (!hold) return this.pending.has(id) ? "printing" : "shown";
		return this.ports.printed() >= hold.callEnd ? "shown" : "staged";
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
			if (previous < hold.callEnd && hold.callEnd <= printed) return true;
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

/** The text a tool result carries — what the stage is asked to perform of it. */
export function resultText(result: { readonly content: readonly ResultBlock[] }): string {
	const texts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
	}
	return texts.join("\n");
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

function wrapResult(render: ResultRenderer, hold: ToolHold): ResultRenderer {
	return (result, options, theme, context) => {
		const text = resultText(result);
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
		renderResult: result ? wrapResult(result, hold) : result,
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
