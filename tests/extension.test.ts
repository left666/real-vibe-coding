import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import codeDance from "../extensions/code-dance/index.ts";
import { stagedNotice } from "../extensions/code-dance/parts.ts";
import { endOfTrack, header, noteOff, noteOn, sequence, track } from "./smf.ts";

interface Stub {
	events: Map<string, (event: unknown, ctx: unknown) => unknown>;
	transformers: ((markdown: string, context: TransformerContext) => string)[];
	shortcuts: { key: string; handler: () => unknown }[];
	commands: string[];
	tools: ToolDefinition[];
}

interface TransformerContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

interface ToolDefinition {
	name: string;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
	renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
}

/** A theme that leaves the text alone; the renderers under test only style it. */
const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Every track the package ships; each is one the playlist may reach for. */
const PACKAGED = ["Angry Birds.mid", "Elysium.mid", "Graze The Roof.mid", "He's a Pirate.mid", "Night Cruising.mid"];

/**
 * Shadow every packaged track with one of the test's own — no `.wav` beside it,
 * so the clock is the MIDI's and nothing reaches the speakers. Whichever name
 * the playlist picks leads the same life.
 */
function shadowLibrary(agentDir: string, beat: Uint8Array): void {
	const music = join(agentDir, "code-dance", "music");
	mkdirSync(music, { recursive: true });
	for (const name of PACKAGED) writeFileSync(join(music, name), beat);
}

function extension(): Stub {
	const stub: Stub = { events: new Map(), transformers: [], shortcuts: [], commands: [], tools: [] };
	codeDance({
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => void stub.events.set(name, handler),
		registerMarkdownTransformer: (transformer: (markdown: string, context: TransformerContext) => string) =>
			void stub.transformers.push(transformer),
		registerShortcut: (key: string, spec: { handler: () => unknown }) => void stub.shortcuts.push({ key, handler: spec.handler }),
		registerCommand: (name: string) => void stub.commands.push(name),
		registerTool: (definition: ToolDefinition) => void stub.tools.push(definition),
	} as never);
	return stub;
}

test("the extension registers the whole surface it needs", () => {
	const stub = extension();

	assert.deepEqual(
		[...stub.events.keys()].sort(),
		[
			"agent_settled",
			"agent_start",
			"before_provider_request",
			"message_end",
			"message_start",
			"message_update",
			"session_shutdown",
			"session_start",
			"tool_call",
			"tool_execution_start",
			"tool_result",
		],
	);
	assert.equal(stub.transformers.length, 1);
	assert.deepEqual(
		stub.shortcuts.map((shortcut) => shortcut.key),
		["ctrl+alt+d", "ctrl+alt+p", "ctrl+alt+n"],
	);
	assert.deepEqual(stub.commands, ["code-dance"]);
});

test("the guard refuses a command that would kill pi with the rest of node", async () => {
	const stub = extension();
	const handler = stub.events.get("tool_call")!;

	const blocked = (await handler(
		{ toolCallId: "call-1", toolName: "bash", input: { command: "taskkill //F //IM node.exe" } },
		{},
	)) as { block?: boolean; reason?: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason!, /PID/);

	// A kill that names its target — or an unrelated command — is let through.
	const pid = { toolCallId: "call-2", toolName: "bash", input: { command: "taskkill //F //PID 1234" } };
	assert.equal(await handler(pid, {}), undefined);
	assert.equal(await handler({ toolCallId: "call-3", toolName: "bash", input: { command: "npm test" } }, {}), undefined);
});

test("the transformer stands aside until something is performed", () => {
	const stub = extension();
	const transformer = stub.transformers[0]!;

	const context = (messageType: TransformerContext["messageType"], isStreaming: boolean): TransformerContext => ({
		messageType,
		isStreaming,
		availableWidth: 80,
	});

	assert.equal(transformer("real text", context("assistant", true)), "real text");
	assert.equal(transformer("real text", context("assistant", false)), "real text");
	assert.equal(transformer("real text", context("user", true)), "real text");
	assert.equal(transformer("real text", context("assistant-thinking", false)), "real text");
});

test("outside a terminal session the extension only watches", async () => {
	const stub = extension();
	const widgets: string[] = [];
	const notified: string[] = [];
	const ctx = {
		mode: "print",
		ui: {
			notify: (message: string) => void notified.push(message),
			setWidget: (key: string) => void widgets.push(key),
		},
	};

	const events: Record<string, unknown> = {
		session_start: {},
		session_shutdown: {},
		agent_start: {},
		message_start: { message: { role: "assistant" } },
		message_update: {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
		},
		message_end: { message: { role: "assistant" } },
		tool_call: { toolCallId: "call-1", toolName: "bash", input: { command: "npm test" } },
		tool_execution_start: { toolCallId: "call-1", toolName: "read", args: { file_path: "a.ts" } },
		tool_result: { toolCallId: "call-1", content: [{ type: "text", text: "output" }] },
		agent_settled: {},
		before_provider_request: {},
	};

	for (const name of stub.events.keys()) {
		await stub.events.get(name)!(events[name], ctx);
	}

	// No stage, no notice: nothing in a mode without a transcript to perform into.
	assert.deepEqual(widgets, []);
	assert.deepEqual(notified, []);

	// The shortcut is safe before a session starts, and after it has shutdown.
	for (const shortcut of stub.shortcuts) await shortcut.handler();
});

test("the stage is mounted with the task's first output and taken down when it ends", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "code-dance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	// Shadow every packaged track with a silent one of the same name: the
	// performance then stays off the speakers whatever track the playlist picks.
	const beat = sequence(header(0, 1, 480), track(noteOn(0, 60, 100), endOfTrack(480)));
	shadowLibrary(agentDir, beat);

	const stub = extension();
	const widgets: { key: string; factory: unknown }[] = [];
	const statuses: { key: string; text: string | undefined }[] = [];
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: {
			notify: () => {},
			setWidget: (key: string, factory: unknown) => void widgets.push({ key, factory }),
			setStatus: (key: string, text: string | undefined) => void statuses.push({ key, text }),
			theme: PLAIN_THEME,
		},
	};
	const update = (delta: string) => ({
		message: { role: "assistant", content: [{ type: "text", text: delta }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	});

	await stub.events.get("session_start")!({}, ctx);

	// A task has not started: no stage, and the transformer leaves the text alone.
	assert.equal(widgets.length, 0);

	// The footer marker stands in for the stage on the empty screen.
	assert.equal(statuses.length, 1);
	assert.equal(statuses[0]!.key, "code-dance");
	assert.equal(statuses[0]!.text, "♪ performance mode");

	await stub.events.get("message_start")!({ message: { role: "assistant" } }, ctx);
	await stub.events.get("message_update")!(update("hello"), ctx);

	// The first output mounts it.
	assert.equal(widgets.length, 1);
	assert.equal(widgets[0]!.key, "code-dance");
	assert.equal(typeof widgets[0]!.factory, "function");

	// The task is over; the first strike lands a beat later and takes the stage
	// down with it.
	await stub.events.get("agent_settled")!({}, ctx);
	const deadline = Date.now() + 4000;
	while (widgets.length < 2 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	assert.equal(widgets.length, 2);
	assert.equal(widgets[1]!.key, "code-dance");
	assert.equal(widgets[1]!.factory, undefined);
	assert.equal(
		stub.transformers[0]!("real text", { messageType: "assistant", isStreaming: false, availableWidth: 80 }),
		"real text",
	);

	await stub.events.get("session_shutdown")!({}, ctx);

	// The marker goes with the session.
	assert.equal(statuses.length, 2);
	assert.equal(statuses[1]!.key, "code-dance");
	assert.equal(statuses[1]!.text, undefined);
});

test("a part stands in until the music has printed it, then swaps itself back", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "code-dance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	// Three strikes half a second apart: enough to print a part in pieces, so the
	// swap can be watched happening between them.
	const beat = sequence(
		header(0, 1, 480),
		track(noteOn(0, 60, 100), noteOn(480, 60, 100), noteOn(480, 60, 100), endOfTrack(480 * 100)),
	);
	shadowLibrary(agentDir, beat);

	const stub = extension();
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: {
			notify: () => {},
			setWidget: () => {},
			setStatus: () => {},
			theme: PLAIN_THEME,
		},
	};
	const text = "a".repeat(80);
	const assistant: TransformerContext = { messageType: "assistant", isStreaming: false, availableWidth: 80 };
	const transformer = stub.transformers[0]!;

	await stub.events.get("session_start")!({}, ctx);
	await stub.events.get("message_start")!({ message: { role: "assistant" } }, ctx);
	await stub.events.get("message_update")!(
		{
			message: { role: "assistant", content: [{ type: "text", text }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
		},
		ctx,
	);
	await stub.events.get("message_end")!({ message: { role: "assistant" } }, ctx);

	// The message is final but the first strike is still a third of a second out:
	// the part stands in as a notice of what the stage is doing with it.
	assert.equal(transformer(text, assistant), stagedNotice(text));

	// The strikes print it in pieces; the swap is the moment the last piece lands.
	const deadline = Date.now() + 4000;
	while (transformer(text, assistant) !== text && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(transformer(text, assistant), text);

	await stub.events.get("agent_settled")!({}, ctx);
	await stub.events.get("session_shutdown")!({}, ctx);
});

test("the pause shortcut holds the music while the printing runs on at pi's pace", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "code-dance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	// A strike at zero and the next one two seconds out: the first prints
	// eight tokens, and the rest would wait for the second — the hold prints
	// them now.
	const beat = sequence(header(0, 1, 480), track(noteOn(0, 60, 100), noteOff(480, 60), noteOn(480 * 4, 60, 100), endOfTrack(480 * 8)));
	shadowLibrary(agentDir, beat);

	const stub = extension();
	const widgets: { key: string; factory: unknown }[] = [];
	const notifications: string[] = [];
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: {
			notify: (message: string) => void notifications.push(message),
			setWidget: (key: string, factory: unknown) => void widgets.push({ key, factory }),
			setStatus: () => {},
			theme: PLAIN_THEME,
		},
	};
	const update = (delta: string) => ({
		message: { role: "assistant", content: [{ type: "text", text: delta }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	});

	await stub.events.get("session_start")!({}, ctx);
	await stub.events.get("message_start")!({ message: { role: "assistant" } }, ctx);
	// Twenty tokens; the strike at zero prints eight of them, the rest
	// waits for the strike two seconds out.
	for (let index = 0; index < 20; index++) {
		await stub.events.get("message_update")!(update(`#${index}`), ctx);
	}
	await stub.events.get("message_end")!({ message: { role: "assistant" } }, ctx);

	const component = (widgets[0]!.factory as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
		{ requestRender: () => {}, invalidate: () => {} },
		PLAIN_THEME,
	);
	const lines = () => component.render(60);
	// Everything under the meter: the text rows, and — while held — the wait that
	// closes the panel.
	const tail = () => lines().slice(2).join("\n");
	const until = async (done: () => boolean): Promise<boolean> => {
		const deadline = Date.now() + 4000;
		while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15));
		return done();
	};

	assert.ok(await until(() => tail().includes("#6")), "the first strike should print the first tokens");
	assert.ok(!tail().includes("#8"), "the second strike is still two seconds out");

	// The hold: the header says so, and the row that closes the panel says the
	// printing is not the thing being held.
	const pause = stub.shortcuts.find((shortcut) => shortcut.key === "ctrl+alt+p")!;
	await pause.handler();
	assert.match(lines()[0]!, /⏸ paused/);
	assert.match(lines().at(-1)!, /printing goes on/);
	assert.match(lines().at(-1)!, /ctrl\+alt\+p to resume/);
	assert.deepEqual(notifications, ["♪ performance paused · printing goes on"]);

	// The beats are gone, so the queue is not held: the rest went out at once.
	// The tail then stands only because there is nothing left to print.
	assert.ok(tail().includes("#8"));
	const held = tail();
	await new Promise((resolve) => setTimeout(resolve, 800));
	assert.equal(tail(), held);
	assert.match(lines()[0]!, /⏸ paused/);

	// Let it go: the music takes over again, and the settled task's empty queue
	// is what ends the performance — the stage comes down and the text is back.
	await pause.handler();
	assert.deepEqual(notifications, ["♪ performance paused · printing goes on", "♪ performance resumed"]);
	await stub.events.get("agent_settled")!({}, ctx);
	assert.ok(await until(() => widgets.length === 2), "the performance should end once the task has settled");
	assert.equal(widgets[1]!.factory, undefined);
	assert.match(lines()[0]!, /♪ waiting for output…/);

	await stub.events.get("session_shutdown")!({}, ctx);
});

test("the next-track shortcut is silent while the music plays and speaks under the hold", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "code-dance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	// A strike at zero and a long tail: whatever track is open, the first beat
	// prints the text and leaves the track running.
	const beat = sequence(header(0, 1, 480), track(noteOn(0, 60, 100), endOfTrack(480 * 100)));
	shadowLibrary(agentDir, beat);

	const stub = extension();
	const notifications: string[] = [];
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: {
			notify: (message: string) => void notifications.push(message),
			setWidget: () => {},
			setStatus: () => {},
			theme: PLAIN_THEME,
		},
	};
	const press = (key: string) => stub.shortcuts.find((shortcut) => shortcut.key === key)!.handler();

	await stub.events.get("session_start")!({}, ctx);

	// Nothing is playing: the press is silent.
	await press("ctrl+alt+n");
	assert.deepEqual(notifications, []);

	await stub.events.get("message_start")!({ message: { role: "assistant" } }, ctx);
	await stub.events.get("message_update")!(
		{
			message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
		},
		ctx,
	);

	// While the music plays the cut itself is the feedback, so the press stays
	// silent; under the hold the stage has nothing to show yet, and the notice
	// says when the press takes effect.
	await press("ctrl+alt+n");
	assert.deepEqual(notifications, []);
	await press("ctrl+alt+p");
	await press("ctrl+alt+n");
	assert.deepEqual(notifications, ["♪ performance paused · printing goes on", "♪ next track · plays on resume"]);

	await stub.events.get("session_shutdown")!({}, ctx);
});

test("the dry wait is named: the running tool first, the model after", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "code-dance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	// Strikes at half a second, a second, and two and a half: the call line prints
	// on the first, the result on the third, and the wait between them is dry.
	const beat = sequence(
		header(0, 1, 480),
		track(noteOn(0, 60, 100), noteOn(480, 60, 100), noteOn(480 * 4, 60, 100), endOfTrack(480 * 100)),
	);
	shadowLibrary(agentDir, beat);

	const stub = extension();
	const widgets: { key: string; factory: unknown }[] = [];
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: {
			notify: () => {},
			setWidget: (key: string, factory: unknown) => void widgets.push({ key, factory }),
			setStatus: () => {},
			theme: PLAIN_THEME,
		},
	};

	await stub.events.get("session_start")!({}, ctx);
	await stub.events.get("message_update")!(
		{
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }],
			},
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}" },
		},
		ctx,
	);
	await stub.events.get("tool_execution_start")!(
		{ toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } },
		ctx,
	);

	// The stage is mounted on the first output; its panel is what carries the line.
	const factory = widgets[0]!.factory as (tui: unknown, theme: unknown) => { render(width: number): string[] };
	const component = factory({ requestRender: () => {}, invalidate: () => {} }, PLAIN_THEME);
	const rendered = () => component.render(60).join("\n");
	const lastRow = () => component.render(60).at(-1)!.trimEnd();
	const until = async (done: () => boolean): Promise<boolean> => {
		const deadline = Date.now() + 4000;
		while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		return done();
	};

	// The line has printed and the tool still runs: the panel's last row waits
	// out loud, naming the tool and its seconds.
	assert.ok(await until(() => /^⏳ \$ npm test · \d+s$/.test(lastRow())));
	assert.equal(component.render(60).length, 12);

	// The result reaches the queue — something to print again — and the wait
	// is over.
	await stub.events.get("tool_result")!(
		{ toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "hello world" }], isError: false },
		ctx,
	);
	assert.doesNotMatch(rendered(), /⏳/);

	// Once the result has printed too, the wait is the model's — still the row
	// that closes the panel.
	assert.ok(await until(() => lastRow() === "⏳ waiting for the model…"));
	assert.equal(component.render(60).length, 12);

	await stub.events.get("agent_settled")!({}, ctx);
	await stub.events.get("session_shutdown")!({}, ctx);
});

test("a tool block stands in until the stage has printed it, then renders itself", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "code-dance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	// A strike a third of a second out, strong enough to print a short call line
	// and its short result in one go.
	const beat = sequence(header(0, 1, 480), track(noteOn(0, 60, 100), endOfTrack(480 * 100)));
	shadowLibrary(agentDir, beat);

	const stub = extension();
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: {
			notify: () => {},
			setWidget: () => {},
			setStatus: () => {},
			theme: PLAIN_THEME,
		},
	};

	await stub.events.get("session_start")!({}, ctx);

	// The built-in tools are registered again, this time with their renderers
	// wrapped: the grep tool's definition is what draws the block below.
	assert.deepEqual(
		stub.tools.map((tool) => tool.name).sort(),
		["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"],
	);
	const grep = stub.tools.find((tool) => tool.name === "grep")!;
	assert.ok(grep.renderCall);
	assert.ok(grep.renderResult);

	const renderContext = {
		toolCallId: "call-1",
		cwd: process.cwd(),
		expanded: false,
		showImages: true,
		isError: false,
		lastComponent: undefined,
	};
	const callBlock = () => grep.renderCall!({ pattern: "TODO", path: "src" }, PLAIN_THEME, renderContext).render(200).join("\n");
	const resultBlock = (isPartial: boolean) =>
		grep.renderResult!(
			{ content: [{ type: "text", text: "hello world" }] },
			{ expanded: false, isPartial },
			PLAIN_THEME,
			renderContext,
		)
			.render(200)
			.join("\n");

	// The call streams into the message: its block is drawn before the line has
	// reached the stage, and stands in for it.
	await stub.events.get("message_update")!(
		{
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "grep", arguments: { pattern: "TODO", path: "src" } }],
			},
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}" },
		},
		ctx,
	);
	assert.match(callBlock(), /▶ printing · grep \/TODO\/ in src/);

	// The line is queued at the tool's start; the block says so until it prints.
	await stub.events.get("tool_execution_start")!(
		{ toolCallId: "call-1", toolName: "grep", args: { pattern: "TODO", path: "src" } },
		ctx,
	);
	assert.match(callBlock(), /▶ performing · grep \/TODO\/ in src/);

	// The result lands and waits in the queue under its own notice.
	await stub.events.get("tool_result")!(
		{ toolCallId: "call-1", toolName: "grep", content: [{ type: "text", text: "hello world" }], isError: false },
		ctx,
	);
	assert.match(resultBlock(false), /▶ performing · 1 line · 11 chars/);

	// The strike prints both; each block hands itself back to its own renderer —
	// the grep renderer for the call, and the text for the result.
	const deadline = Date.now() + 4000;
	while (callBlock().includes("performing") && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.match(callBlock(), /grep \/TODO\/ in src/);
	assert.doesNotMatch(callBlock(), /performing|printing/);
	assert.match(resultBlock(false), /hello world/);
	assert.doesNotMatch(resultBlock(false), /performing|printing/);

	await stub.events.get("agent_settled")!({}, ctx);
	await stub.events.get("session_shutdown")!({}, ctx);
});

test("the content of a read file is not performed", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "code-dance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	// Strikes every half second: were the file's text queued, the stage would
	// have printed all of it before the watch below is over.
	const beat = sequence(
		header(0, 1, 480),
		track(noteOn(0, 60, 100), noteOn(480, 60, 100), noteOn(480, 60, 100), noteOn(480, 60, 100), endOfTrack(480 * 100)),
	);
	shadowLibrary(agentDir, beat);

	const stub = extension();
	const widgets: { key: string; factory: unknown }[] = [];
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: {
			notify: () => {},
			setWidget: (key: string, factory: unknown) => void widgets.push({ key, factory }),
			setStatus: () => {},
			theme: PLAIN_THEME,
		},
	};

	await stub.events.get("session_start")!({}, ctx);
	await stub.events.get("message_update")!(
		{
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { file_path: "a.ts" } }],
			},
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}" },
		},
		ctx,
	);
	await stub.events.get("tool_execution_start")!(
		{ toolCallId: "call-1", toolName: "read", args: { file_path: "a.ts" } },
		ctx,
	);

	const factory = widgets[0]!.factory as (tui: unknown, theme: unknown) => { render(width: number): string[] };
	const component = factory({ requestRender: () => {}, invalidate: () => {} }, PLAIN_THEME);
	const rendered = () => component.render(60).join("\n");
	const until = async (done: () => boolean): Promise<boolean> => {
		const deadline = Date.now() + 4000;
		while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		return done();
	};

	// The call line is performed as ever: it is the agent's own text, not the file.
	assert.ok(await until(() => rendered().includes("read a.ts")));

	// The file lands: its block draws itself at once — expanded, the text right
	// there — with nothing of it waiting on the stage.
	const body = "const secret = 1;";
	await stub.events.get("tool_result")!(
		{ toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: body }], isError: false },
		ctx,
	);
	const read = stub.tools.find((tool) => tool.name === "read")!;
	const resultBlock = read
		.renderResult!(
			{ content: [{ type: "text", text: body }] },
			{ expanded: true, isPartial: false },
			PLAIN_THEME,
			{ toolCallId: "call-1", cwd: process.cwd(), expanded: false, showImages: true, isError: false, lastComponent: undefined },
		)
		.render(200)
		.join("\n");
	assert.match(resultBlock, /const secret = 1;/);
	assert.doesNotMatch(resultBlock, /▶|performing|printing/);

	// Beats come and go; the file's text never reaches the stage.
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert.doesNotMatch(rendered(), /secret/);
	assert.match(rendered(), /read a\.ts/);

	await stub.events.get("agent_settled")!({}, ctx);
	await stub.events.get("session_shutdown")!({}, ctx);
});

/** A stage harness over the beats, the stub and the panel, for one tool's result. */
async function staged(t: { after(fn: () => void): void }, args: Record<string, unknown>, name: string) {
	const agentDir = mkdtempSync(join(tmpdir(), "code-dance-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	// Strikes half a second apart: the call line prints on the first one after it
	// lands, and the work — priced token by token — takes several beats, so the
	// block that previews it can be watched standing in.
	const beat = sequence(
		header(0, 1, 480),
		track(
			noteOn(0, 60, 100),
			noteOn(480, 60, 100),
			noteOn(480 * 2, 60, 100),
			noteOn(480 * 3, 60, 100),
			noteOn(480 * 4, 60, 100),
			noteOn(480 * 5, 60, 100),
			noteOn(480 * 6, 60, 100),
			noteOn(480 * 7, 60, 100),
			endOfTrack(480 * 100),
		),
	);
	shadowLibrary(agentDir, beat);

	const stub = extension();
	const widgets: { key: string; factory: unknown }[] = [];
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		ui: {
			notify: () => {},
			setWidget: (key: string, factory: unknown) => void widgets.push({ key, factory }),
			setStatus: () => {},
			theme: PLAIN_THEME,
		},
	};

	await stub.events.get("session_start")!({}, ctx);
	await stub.events.get("message_update")!(
		{
			message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name, arguments: args }] },
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}" },
		},
		ctx,
	);
	await stub.events.get("tool_execution_start")!({ toolCallId: "call-1", toolName: name, args }, ctx);

	const factory = widgets[0]!.factory as (tui: unknown, theme: unknown) => { render(width: number): string[] };
	const component = factory({ requestRender: () => {}, invalidate: () => {} }, PLAIN_THEME);
	return {
		stub,
		ctx,
		tool: stub.tools.find((tool) => tool.name === name)!,
		rendered: () => component.render(60).join("\n"),
		until: async (done: () => boolean): Promise<boolean> => {
			const deadline = Date.now() + 4000;
			while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
			return done();
		},
	};
}

test("a write performs the text it put down, not its receipt", async (t) => {
	const content = Array.from({ length: 6 }, (_, line) => `const line${line} = ${line};`).join("\n");
	const { stub, ctx, tool, rendered, until } = await staged(t, { path: "notes.ts", content }, "write");

	// The call line is performed; the write is named before the work prints.
	assert.ok(await until(() => rendered().includes("write notes.ts")));

	const receipt = { content: [{ type: "text", text: "Successfully wrote to notes.ts" }], details: undefined };
	await stub.events.get("tool_result")!(
		{ toolCallId: "call-1", toolName: "write", input: { path: "notes.ts", content }, ...receipt, isError: false },
		ctx,
	);

	// The call block previews the work itself, so it stands in with the result's:
	// its line printed long ago, and the work is still beats away.
	const callBlock = () =>
		tool
			.renderCall!({ path: "notes.ts", content }, PLAIN_THEME, {
				toolCallId: "call-1",
				cwd: process.cwd(),
				expanded: false,
				argsComplete: true,
				lastComponent: undefined,
			})
			.render(200)
			.join("\n");
	assert.match(callBlock(), /▶ performing · write notes\.ts/);

	// The result block stands in for the text put down — the receipt is not what waits.
	const resultBlock = () =>
		tool
			.renderResult!(receipt, { expanded: false, isPartial: false }, PLAIN_THEME, {
				toolCallId: "call-1",
				cwd: process.cwd(),
				expanded: false,
				showImages: true,
				isError: false,
				lastComponent: undefined,
				args: { path: "notes.ts", content },
			})
			.render(200)
			.join("\n");
	assert.match(resultBlock(), /▶ performing · 6 lines · 101 chars/);

	// The strikes print the text itself; the receipt never reaches the stage.
	assert.ok(await until(() => rendered().includes("const line5 = 5;")), "the last line of the work is what marks it printed");
	assert.doesNotMatch(rendered(), /Successfully/);

	// The work is printed; only now does the preview draw itself.
	assert.doesNotMatch(callBlock(), /▶/);
	assert.match(callBlock(), /write notes\.ts/);
	assert.ok(callBlock().split("\n").length >= 3, "the preview is there, not just the line");

	await stub.events.get("agent_settled")!({}, ctx);
	await stub.events.get("session_shutdown")!({}, ctx);
});

test("an edit performs the diff it worked out, not its receipt", async (t) => {
	const diff = ["-1 let x = 1;", "+1 let x = 2;", "-4 let y = 3;", "+4 let y = 4;", "-7 let z = 5;", "+7 let z = 6;"].join("\n");
	const edits = [{ oldText: "let x = 1;", newText: "let x = 2;" }];
	const { stub, ctx, tool, rendered, until } = await staged(t, { path: "a.ts", edits }, "edit");

	// The call line is performed; the edit is named before the diff prints.
	assert.ok(await until(() => rendered().includes("edit a.ts")));

	const result = {
		content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
		details: { diff, patch: "", firstChangedLine: 1 },
	};
	await stub.events.get("tool_result")!(
		{ toolCallId: "call-1", toolName: "edit", input: { path: "a.ts", edits }, ...result, isError: false },
		ctx,
	);

	// The call block previews the diff itself, so it stands in with the result's:
	// the preview the renderer works out from the call's args is held back until
	// the diff has printed.
	const callBlock = () =>
		tool
			.renderCall!({ path: "a.ts", edits }, PLAIN_THEME, {
				toolCallId: "call-1",
				cwd: process.cwd(),
				expanded: false,
				argsComplete: true,
				lastComponent: undefined,
				state: {},
				invalidate: () => {},
			})
			.render(200)
			.join("\n");
	assert.match(callBlock(), /▶ performing · edit a\.ts/);

	// The block stands in for the diff — six lines, not the receipt's one.
	const resultBlock = () =>
		tool
			.renderResult!(result, { expanded: false, isPartial: false }, PLAIN_THEME, {
				toolCallId: "call-1",
				cwd: process.cwd(),
				expanded: false,
				showImages: true,
				isError: false,
				lastComponent: undefined,
				args: { path: "a.ts", edits },
			})
			.render(200)
			.join("\n");
	assert.match(resultBlock(), /▶ performing · 6 lines · 83 chars/);

	// The strikes print the diff; the receipt never reaches the stage.
	assert.ok(await until(() => rendered().includes("+7 let z = 6;")), "the last line of the diff is what marks it printed");
	assert.doesNotMatch(rendered(), /Successfully/);

	// The diff is printed; only now does the preview draw itself.
	assert.doesNotMatch(callBlock(), /▶/);
	assert.match(callBlock(), /edit a\.ts/);

	await stub.events.get("agent_settled")!({}, ctx);
	await stub.events.get("session_shutdown")!({}, ctx);
});
