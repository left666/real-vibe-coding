import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import codeDance from "../extensions/code-dance/index.ts";
import { endOfTrack, header, noteOn, sequence, track } from "./smf.ts";

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
		ui: {
			notify: () => {},
			setWidget: (key: string, factory: unknown) => void widgets.push({ key, factory }),
			setStatus: (key: string, text: string | undefined) => void statuses.push({ key, text }),
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	const update = (delta: string) => ({
		message: { role: "assistant" },
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
