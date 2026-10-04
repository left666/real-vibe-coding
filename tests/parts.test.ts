import assert from "node:assert/strict";
import { test } from "node:test";

import { callLine, countLines, partKey, performedParts, printingCall, printingNotice, stagedCall, stagedNotice, toolCallText } from "../extensions/code-dance/parts.ts";

test("partKey is stable, short and distinct", () => {
	assert.equal(partKey("hello"), partKey("hello"));
	assert.notEqual(partKey("hello"), partKey("hello "));
	assert.match(partKey(""), /^[0-9a-f]{16}$/);
	assert.equal(partKey("hello").length, 16);
});

test("countLines counts lines, and nothing has none", () => {
	assert.equal(countLines(""), 0);
	assert.equal(countLines("a"), 1);
	assert.equal(countLines("a\nb"), 2);
	assert.equal(countLines("a\n"), 2);
});

test("performedParts: text blocks are one unit each, trimmed", () => {
	assert.deepEqual(performedParts([{ type: "text", text: "  one  " }, { type: "text", text: "two" }]), [
		{ kind: "text", text: "one" },
		{ kind: "text", text: "two" },
	]);
});

test("performedParts: a run of reasoning blocks is one unit", () => {
	assert.deepEqual(
		performedParts([
			{ type: "thinking", thinking: " first " },
			{ type: "thinking", thinking: "second" },
			{ type: "text", text: "answer" },
		]),
		[
			{ kind: "thinking", text: "first\n\nsecond" },
			{ kind: "text", text: "answer" },
		],
	);
});

test("performedParts: anything that is not text ends the reasoning run", () => {
	assert.deepEqual(
		performedParts([
			{ type: "thinking", thinking: "before" },
			{ type: "toolCall", id: "x", name: "read", arguments: {} },
			{ type: "thinking", thinking: "after" },
		]),
		[
			{ kind: "thinking", text: "before" },
			{ kind: "thinking", text: "after" },
		],
	);
});

test("performedParts: whitespace-only blocks are not units", () => {
	assert.deepEqual(performedParts([{ type: "text", text: "   " }, { type: "thinking", thinking: "\n" }]), []);
});

test("performedParts: a run at the end of the message is flushed", () => {
	assert.deepEqual(performedParts([{ type: "thinking", thinking: "last" }]), [{ kind: "thinking", text: "last" }]);
});

test("performedParts: junk content yields nothing", () => {
	assert.deepEqual(performedParts(undefined), []);
	assert.deepEqual(performedParts("text"), []);
	assert.deepEqual(performedParts([]), []);
	assert.deepEqual(performedParts([null, 7, { type: "text" }, { type: "text", text: 9 }]), []);
});

test("the notices describe the part they stand in for", () => {
	assert.equal(stagedNotice("a\nb"), "▶ performing · 2 lines · 3 chars");
	assert.equal(printingNotice("a"), "▶ printing · 1 line · 1 char");
});

test("the call notices name the line instead of measuring it", () => {
	assert.equal(stagedCall("read a.ts"), "▶ performing · read a.ts");
	assert.equal(printingCall("$ ls -la"), "▶ printing · $ ls -la");
});

test("toolCallText: shell calls are shown as the shell", () => {
	assert.equal(toolCallText("bash", { command: "ls -la" }, ""), "$ ls -la\n");
	assert.equal(toolCallText("powershell", { command: "Get-ChildItem" }, ""), "PS> Get-ChildItem\n");
});

test("toolCallText: file calls name the path, the working directory otherwise", () => {
	assert.equal(toolCallText("read", { file_path: "/a/b.txt" }, ""), "read /a/b.txt\n");
	assert.equal(toolCallText("write", { path: "notes.md" }, ""), "write notes.md\n");
	assert.equal(toolCallText("read", {}, ""), "read .\n");
	assert.equal(toolCallText("ls", null, ""), "ls .\n");
});

test("toolCallText: grep and find show the pattern", () => {
	assert.equal(toolCallText("grep", { pattern: "TODO", path: "src" }, ""), "grep /TODO/ in src\n");
	assert.equal(toolCallText("find", { pattern: "*.ts", path: "src" }, ""), "find *.ts in src\n");
});

test("toolCallText: an unknown tool shows its arguments", () => {
	assert.equal(toolCallText("task", { prompt: "go" }, ""), 'task {"prompt":"go"}\n');
	assert.equal(toolCallText("task", {}, ""), "task\n");
	assert.equal(toolCallText("task", undefined, ""), "task\n");
});

test("toolCallText opens a line of its own unless one just ended", () => {
	assert.equal(toolCallText("bash", { command: "x" }, "abc"), "\n$ x\n");
	assert.equal(toolCallText("bash", { command: "x" }, "\n"), "$ x\n");
});

test("callLine is one line, clipped", () => {
	assert.equal(callLine("read", { file_path: "a.ts" }), "read a.ts");
	assert.equal(callLine("bash", { command: "ls -la\ncat a" }), "$ ls -la");

	const long = callLine("bash", { command: "a".repeat(200) });
	assert.equal(long.length, 100);
	assert.ok(long.endsWith("…"));
	assert.ok(long.startsWith("$ aaa"));
});
