import assert from "node:assert/strict";
import { test } from "node:test";

import codeDance from "../extensions/code-dance/index.ts";

interface Stub {
	events: Map<string, (event: unknown, ctx: unknown) => unknown>;
	transformers: ((markdown: string, context: TransformerContext) => string)[];
	shortcuts: { key: string; handler: () => unknown }[];
	commands: string[];
}

interface TransformerContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

function extension(): Stub {
	const stub: Stub = { events: new Map(), transformers: [], shortcuts: [], commands: [] };
	codeDance({
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => void stub.events.set(name, handler),
		registerMarkdownTransformer: (transformer: (markdown: string, context: TransformerContext) => string) =>
			void stub.transformers.push(transformer),
		registerShortcut: (key: string, spec: { handler: () => unknown }) => void stub.shortcuts.push({ key, handler: spec.handler }),
		registerCommand: (name: string) => void stub.commands.push(name),
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
