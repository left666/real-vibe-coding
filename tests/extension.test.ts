import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import codeDance from "../extensions/code-dance/index.ts";
import { stagedNotice } from "../extensions/code-dance/parts.ts";
import { endOfTrack, header, noteOn, sequence, track } from "./smf.ts";

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
const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

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
			"tool_execution_start",
			"tool_result",
		],
	);
	assert.equal(stub.transformers.length, 1);
	assert.deepEqual(
		stub.shortcuts.map((shortcut) => shortcut.key),
		["ctrl+shift+d"],
	);
	assert.deepEqual(stub.commands, ["code-dance"]);
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
	const music = join(agentDir, "code-dance", "music");
	mkdirSync(music, { recursive: true });
	const beat = sequence(header(0, 1, 480), track(noteOn(0, 60, 100), endOfTrack(480)));
	for (const name of ["He's a Pirate.mid", "Night Cruising.mid", "PVZ.mid"]) {
		writeFileSync(join(music, name), beat);
	}

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
	assert.equal(statuses[0]!.text, "♪ 演出模式");

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
	const music = join(agentDir, "code-dance", "music");
	mkdirSync(music, { recursive: true });
	const beat = sequence(
		header(0, 1, 480),
		track(noteOn(0, 60, 100), noteOn(480, 60, 100), noteOn(480, 60, 100), endOfTrack(480 * 100)),
	);
	for (const name of ["He's a Pirate.mid", "Night Cruising.mid", "PVZ.mid"]) {
		writeFileSync(join(music, name), beat);
	}

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
	const text = "a".repeat(60);
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
	const music = join(agentDir, "code-dance", "music");
	mkdirSync(music, { recursive: true });
	const beat = sequence(
		header(0, 1, 480),
		track(noteOn(0, 60, 100), noteOn(480, 60, 100), noteOn(480 * 4, 60, 100), endOfTrack(480 * 100)),
	);
	for (const name of ["He's a Pirate.mid", "Night Cruising.mid", "PVZ.mid"]) {
		writeFileSync(join(music, name), beat);
	}

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

	// The stage is mounted on the first output; its panel is what carries the line.
	const factory = widgets[0]!.factory as (tui: unknown, theme: unknown) => { render(width: number): string[] };
	const component = factory({ requestRender: () => {}, invalidate: () => {} }, PLAIN_THEME);
	const rendered = () => component.render(60).join("\n");
	const until = async (done: () => boolean): Promise<boolean> => {
		const deadline = Date.now() + 4000;
		while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		return done();
	};

	// The line has printed and the tool still runs: the panel waits out loud,
	// naming the tool and its seconds.
	assert.ok(await until(() => /⏳ read a\.ts · \d+s/.test(rendered())));
	assert.equal(component.render(60).length, 12);

	// The result reaches the queue — something to print again — and the wait
	// is over.
	await stub.events.get("tool_result")!(
		{ toolCallId: "call-1", content: [{ type: "text", text: "hello world" }], isError: false },
		ctx,
	);
	assert.doesNotMatch(rendered(), /⏳/);

	// Once the result has printed too, the wait is the model's.
	assert.ok(await until(() => rendered().includes("等待模型输出")));
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
	const music = join(agentDir, "code-dance", "music");
	mkdirSync(music, { recursive: true });
	const beat = sequence(header(0, 1, 480), track(noteOn(0, 60, 100), endOfTrack(480 * 100)));
	for (const name of ["He's a Pirate.mid", "Night Cruising.mid", "PVZ.mid"]) {
		writeFileSync(join(music, name), beat);
	}

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
	// wrapped: the read tool's definition is what draws the block below.
	assert.deepEqual(
		stub.tools.map((tool) => tool.name).sort(),
		["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"],
	);
	const read = stub.tools.find((tool) => tool.name === "read")!;
	assert.ok(read.renderCall);
	assert.ok(read.renderResult);

	const renderContext = {
		toolCallId: "call-1",
		cwd: process.cwd(),
		expanded: false,
		showImages: true,
		isError: false,
		lastComponent: undefined,
	};
	const callBlock = () => read.renderCall!({ file_path: "a.ts" }, PLAIN_THEME, renderContext).render(200).join("\n");
	const resultBlock = (isPartial: boolean) =>
		read.renderResult!(
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
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { file_path: "a.ts" } }],
			},
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}" },
		},
		ctx,
	);
	assert.match(callBlock(), /▶ 打印中 · read a\.ts/);

	// The line is queued at the tool's start; the block says so until it prints.
	await stub.events.get("tool_execution_start")!(
		{ toolCallId: "call-1", toolName: "read", args: { file_path: "a.ts" } },
		ctx,
	);
	assert.match(callBlock(), /▶ 演出中 · read a\.ts/);

	// The result lands and waits in the queue under its own notice.
	await stub.events.get("tool_result")!(
		{ toolCallId: "call-1", content: [{ type: "text", text: "hello world" }], isError: false },
		ctx,
	);
	assert.match(resultBlock(false), /▶ 演出中 · 1 行 · 11 字/);

	// The strike prints both; each block hands itself back to its own renderer —
	// the read renderer for the call, and emptiness for the collapsed result.
	const deadline = Date.now() + 4000;
	while (callBlock().includes("演出中") && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.match(callBlock(), /read.*a\.ts/);
	assert.doesNotMatch(callBlock(), /演出中|打印中/);
	assert.doesNotMatch(resultBlock(false), /演出中/);

	await stub.events.get("agent_settled")!({}, ctx);
	await stub.events.get("session_shutdown")!({}, ctx);
});
