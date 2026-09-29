import assert from "node:assert/strict";
import { test } from "node:test";

import { PrintQueue, burst } from "../extensions/code-dance/queue.ts";

test("burst: the tempo sets the pace and the accent scales it", () => {
	assert.equal(burst(0, 60), 2);
	assert.equal(burst(1, 60), 16);
	assert.equal(burst(0.5, 60), 9);
	assert.equal(burst(1, 120), 8);
	assert.equal(burst(0, 120), 1);
});

test("burst: one onset always moves the print, whatever the numbers", () => {
	// Velocities outside 0..1 are clamped, not extrapolated.
	assert.equal(burst(-5, 60), burst(0, 60));
	assert.equal(burst(9, 60), burst(1, 60));
	// A nonsensical tempo still leaves the weakest strike one token, never zero.
	assert.ok(burst(0, 240) >= 1);
	assert.ok(burst(0, 0) >= 1);
});

test("a whole chunk is one token and goes out intact", () => {
	const queue = new PrintQueue();
	queue.push("hello", true);

	assert.equal(queue.reveal(1), "hello");
	assert.equal(queue.printed, "hello");
	assert.equal(queue.backlog, 0);
	assert.equal(queue.isEmpty, true);
});

test("a whole chunk longer than any token is priced and cut like text", () => {
	const queue = new PrintQueue();
	queue.push("a".repeat(40), true);

	assert.equal(queue.reveal(1), "aaaa");
	assert.equal(queue.backlog, 36);
});

test("plain text is cut on the character budget", () => {
	const queue = new PrintQueue();
	queue.push("abcdefgh");

	assert.equal(queue.reveal(1), "abcd");
	assert.equal(queue.reveal(1), "efgh");
	assert.equal(queue.reveal(1), "");
});

test("only the first whole chunk of an onset may overrun the budget", () => {
	const queue = new PrintQueue();
	queue.push("ab", true);
	queue.push("cd", true);

	// The half token left over does not buy the second chunk.
	assert.equal(queue.reveal(1.5), "ab");
	assert.equal(queue.reveal(1.5), "cd");
});

test("a whole chunk goes even when the budget cannot hold it", () => {
	const queue = new PrintQueue();
	queue.push("hi", true);

	assert.equal(queue.reveal(0.5), "hi");
});

test("a budget spent on text does not reach a whole chunk", () => {
	const queue = new PrintQueue();
	queue.push("abcd");
	queue.push("hi", true);

	assert.equal(queue.reveal(1), "abcd");
	assert.equal(queue.reveal(1), "hi");
});

test("a cut never lands inside a surrogate pair", () => {
	const queue = new PrintQueue();
	queue.push("abc😀def");

	// Four characters of budget would leave half the pair behind.
	assert.equal(queue.reveal(1), "abc😀");
	assert.equal(queue.reveal(1), "def");
});

test("nothing is inserted between chunks", () => {
	const queue = new PrintQueue();
	queue.push("one ", true);
	queue.push("two", true);

	assert.equal(queue.reveal(2), "one two");
});

test("printed text, backlog and total add up", () => {
	const queue = new PrintQueue();
	assert.equal(queue.tail, "");

	queue.push("one");
	queue.push("two");
	assert.equal(queue.total, 6);
	assert.equal(queue.tail, "o");

	assert.equal(queue.reveal(1), "onet");
	assert.equal(queue.printed, "onet");
	assert.equal(queue.backlog, 2);
	assert.equal(queue.total, 6);
	assert.equal(queue.tail, "o");

	assert.equal(queue.drain(), "wo");
	assert.equal(queue.printed, "onetwo");
	assert.equal(queue.isEmpty, true);
	assert.equal(queue.total, 6);
});

test("a reveal of zero or less prints nothing", () => {
	const queue = new PrintQueue();
	queue.push("abc");

	assert.equal(queue.reveal(0), "");
	assert.equal(queue.reveal(-3), "");
	assert.equal(queue.backlog, 3);
});

test("an empty push is not a chunk", () => {
	const queue = new PrintQueue();
	queue.push("");
	queue.push("", true);

	assert.equal(queue.total, 0);
	assert.equal(queue.reveal(5), "");
});

test("the queue holds many chunks and prints them in order", () => {
	const queue = new PrintQueue();
	const expected: string[] = [];
	for (let index = 0; index < 100; index++) {
		queue.push(`#${index}`, true);
		expected.push(`#${index}`);
	}

	assert.equal(queue.reveal(100), expected.join(""));
	assert.equal(queue.backlog, 0);

	// The spent slots were dropped, so the queue works the same afterwards.
	queue.push("tail", true);
	assert.equal(queue.reveal(1), "tail");
});

test("reset drops the printed text and the backlog alike", () => {
	const queue = new PrintQueue();
	queue.push("abc");
	queue.reveal(1);

	queue.reset();
	assert.equal(queue.printed, "");
	assert.equal(queue.total, 0);
	assert.equal(queue.backlog, 0);
	assert.equal(queue.tail, "");

	queue.push("de", true);
	assert.equal(queue.reveal(1), "de");
});
