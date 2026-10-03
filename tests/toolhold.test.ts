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

	hold.open("call-1", 30);
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
	hold.open("call-1", 10);
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
	hold.open("call-1", 10);
	hold.close("call-1", 0);
	assert.equal(hold.resultState("call-1", false), "shown");
});

test("with the stand-in off nothing is held", () => {
	const { hold, on } = holding();

	hold.expect("call-1");
	hold.open("call-1", 30);
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
	hold.open("call-1", 30);
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
	hold.open("call-1", 10);
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

	hold.open("call-2", 30);
	hold.close("call-2", 60);
	hold.clear();
	assert.equal(hold.callState("call-2"), "shown");
	assert.equal(hold.resultState("call-2", false), "shown");
	assert.equal(hold.crossed(0, 100), false);
});

test("resultText joins the text blocks and skips the rest", () => {
	assert.equal(resultText({ content: [] }), "");
	assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");

	const image = { type: "image", data: "x", mimeType: "image/png" };
	assert.equal(resultText({ content: [{ type: "text", text: "a" }, image] }), "a");
	assert.equal(resultText({ content: [image] }), "");
});
