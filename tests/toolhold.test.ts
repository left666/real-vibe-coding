import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolHold, resultText } from "../extensions/code-dance/toolhold.ts";

/** A hold over mutable stand-ins for the queue and the config. */
function holding(): { hold: ToolHold; printed: { value: number }; on: { value: boolean } } {
	const printed = { value: 0 };
	const on = { value: true };
	return { hold: new ToolHold({ printed: () => printed.value, enabled: () => on.value }), printed, on };
}

test("a call stands in from the moment it streams, through the queue", () => {
	const { hold, printed } = holding();

	hold.expect("call-1");
	assert.equal(hold.callState("call-1"), "printing");
	assert.equal(hold.callState("call-2"), "shown");

	hold.open("call-1", 30, "bash");
	assert.equal(hold.callState("call-1"), "staged");

	printed.value = 29;
	assert.equal(hold.callState("call-1"), "staged");
	printed.value = 30;
	assert.equal(hold.callState("call-1"), "shown");
});

test("the result stands in until the printing passes its text", () => {
	const { hold, printed } = holding();

	hold.close("call-1", 40);
	assert.equal(hold.resultState("call-1", false), "shown", "a tool that was never held draws itself");

	hold.expect("call-1");
	hold.open("call-1", 10, "bash");
	assert.equal(hold.resultState("call-1", false), "printing", "the result has not been queued yet");
	assert.equal(hold.resultState("call-1", true), "printing", "a partial result is not the performed text");

	hold.close("call-1", 40);
	printed.value = 10;
	assert.equal(hold.callState("call-1"), "shown");
	assert.equal(hold.resultState("call-1", false), "staged");

	printed.value = 40;
	assert.equal(hold.resultState("call-1", false), "shown");
});

test("a result with nothing to perform waits for nothing", () => {
	const { hold } = holding();

	hold.expect("call-1");
	hold.open("call-1", 10, "bash");
	hold.close("call-1", 0);
	assert.equal(hold.resultState("call-1", false), "shown");
});

test("with the stand-in off nothing is held", () => {
	const { hold, on } = holding();

	hold.expect("call-1");
	hold.open("call-1", 30, "bash");
	hold.close("call-1", 40);
	on.value = false;
	assert.equal(hold.callState("call-1"), "shown");
	assert.equal(hold.resultState("call-1", false), "shown");

	// And with it on again, what was performed is still held.
	on.value = true;
	assert.equal(hold.callState("call-1"), "staged");
});

test("crossed marks the steps that end a held span", () => {
	const { hold } = holding();

	hold.expect("call-1");
	hold.open("call-1", 30, "bash");
	hold.close("call-1", 50);

	assert.equal(hold.crossed(20, 29), false);
	assert.equal(hold.crossed(29, 30), true, "the call's line is printed");
	assert.equal(hold.crossed(30, 49), false, "between the two ends");
	assert.equal(hold.crossed(49, 50), true, "the result's text is printed");
	assert.equal(hold.crossed(50, 60), false, "already crossed");
});

test("a result that was not performed is never waited for", () => {
	const { hold } = holding();

	hold.expect("call-1");
	hold.open("call-1", 10, "bash");
	hold.close("call-1", 0);
	assert.equal(hold.crossed(0, 100), true, "only the call's line crosses — nothing was queued for the result");
	assert.equal(hold.crossed(5, 9), false);
	assert.equal(hold.crossed(10, 11), false, "past the call's line, and the result asked for no print");
});

test("clear returns every block to its renderer", () => {
	const { hold } = holding();

	hold.expect("call-1");
	assert.equal(hold.callState("call-1"), "printing");
	hold.clear();
	assert.equal(hold.callState("call-1"), "shown");

	hold.open("call-2", 30, "bash");
	hold.close("call-2", 60);
	hold.clear();
	assert.equal(hold.callState("call-2"), "shown");
	assert.equal(hold.resultState("call-2", false), "shown");
	assert.equal(hold.crossed(0, 100), false);
});

test("a write's or edit's call block waits for the work its preview stands for", () => {
	const { hold, printed } = holding();

	hold.expect("call-1");
	hold.open("call-1", 30, "write");
	assert.equal(hold.crossed(0, 100), false, "the tool still runs: not even its line reveals the preview");

	printed.value = 30;
	assert.equal(hold.callState("call-1"), "staged", "the line is printed, the work is not queued yet");

	hold.close("call-1", 90);
	assert.equal(hold.crossed(29, 30), false, "the line goes by: the block waits for the work");
	printed.value = 89;
	assert.equal(hold.callState("call-1"), "staged");
	printed.value = 90;
	assert.equal(hold.callState("call-1"), "shown");
});

test("a previewing call whose work performed nothing is revealed by its close", () => {
	const { hold, printed } = holding();

	hold.expect("call-1");
	hold.open("call-1", 30, "edit");
	printed.value = 30;

	// The close is the only reveal point here — nothing more will print — so the
	// caller is told to repaint.
	assert.equal(hold.close("call-1", 0), true);
	assert.equal(hold.callState("call-1"), "shown");
});

test("close stays quiet when a print, not itself, is what reveals", () => {
	const { hold, printed } = holding();

	hold.expect("call-1");
	hold.open("call-1", 10, "write");
	printed.value = 10;
	assert.equal(hold.close("call-1", 40), false, "the performed work reveals itself by printing");

	hold.expect("call-2");
	hold.open("call-2", 10, "bash");
	printed.value = 10;
	assert.equal(hold.close("call-2", 0), false, "no preview to hold back");
});

test("resultText performs the work of write and edit, nothing of a read, and the text of the rest", () => {
	const image = { type: "image", data: "x", mimeType: "image/png" };
	const receipt = (text: string) => ({ content: [{ type: "text" as const, text }] });

	// What a read brought in is input: the stage is asked for none of it — its
	// error message included.
	assert.equal(resultText("read", { path: "a.ts" }, receipt("file body"), false), "");
	assert.equal(resultText("read", {}, receipt("Error: no such file"), true), "");

	// A write is the text it put down, not the receipt; an edit is the diff it
	// worked out, not the receipt.
	const writeArgs = { path: "a.ts", content: "let x = 1;" };
	assert.equal(resultText("write", writeArgs, receipt("Successfully wrote to a.ts"), false), "let x = 1;");
	assert.equal(resultText("write", { path: "a.ts", content: "" }, receipt("Successfully wrote to a.ts"), false), "");
	const editResult = {
		content: [{ type: "text" as const, text: "Successfully replaced 1 block(s) in a.ts." }],
		details: { diff: "-1 let x = 1;\n+1 let x = 2;", patch: "..." },
	};
	assert.equal(resultText("edit", { path: "a.ts" }, editResult, false), "-1 let x = 1;\n+1 let x = 2;");

	// A failure carries no work: its message is performed as it is.
	assert.equal(resultText("write", writeArgs, receipt("Error: EACCES"), true), "Error: EACCES");
	assert.equal(resultText("edit", { path: "a.ts" }, receipt("Could not edit file: a.ts."), true), "Could not edit file: a.ts.");

	// A result shape without the work falls back to its own text.
	assert.equal(resultText("write", {}, receipt("Successfully wrote to a.ts"), false), "Successfully wrote to a.ts");
	assert.equal(resultText("edit", {}, receipt("Successfully replaced 1 block(s)."), false), "Successfully replaced 1 block(s).");

	// Everything else performs its text blocks, images skipped.
	assert.equal(resultText("bash", {}, { content: [] }, false), "");
	assert.equal(resultText("bash", {}, { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, false), "a\nb");
	assert.equal(resultText("grep", {}, { content: [{ type: "text", text: "a" }, image] }, false), "a");
	assert.equal(resultText("bash", {}, { content: [image] }, false), "");
});
