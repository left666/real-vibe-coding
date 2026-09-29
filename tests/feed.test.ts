import assert from "node:assert/strict";
import { test } from "node:test";

import { OutputFeed } from "../extensions/code-dance/feed.ts";
import type { StreamDelta } from "../extensions/code-dance/feed.ts";
import { partKey, performedParts } from "../extensions/code-dance/parts.ts";
import type { BeatChunk } from "../extensions/code-dance/queue.ts";

function deliver(feed: OutputFeed, events: readonly StreamDelta[]): BeatChunk[] {
	const chunks: BeatChunk[] = [];
	for (const event of events) chunks.push(...feed.push(event));
	return chunks;
}

function prose(index: number, delta: string): StreamDelta {
	return { type: "text_delta", contentIndex: index, delta };
}

function reasoning(index: number, delta: string): StreamDelta {
	return { type: "thinking_delta", contentIndex: index, delta };
}

const CALL: StreamDelta = { type: "toolcall_delta", contentIndex: 1, delta: "{}" };

/** Everything that reached the stage, as one string. */
function played(chunks: readonly BeatChunk[]): string {
	return chunks.map((chunk) => chunk.text).join("");
}

/** The parts the feed staged are exactly the parts the transformer will be asked about. */
function assertSameParts(feed: OutputFeed, content: unknown): void {
	assert.deepEqual(
		feed.takePartKeys(),
		performedParts(content).map((part) => partKey(part.text)),
	);
}

test("prose is trimmed the way the finished message will be", () => {
	const feed = new OutputFeed();
	const chunks = deliver(feed, [prose(0, "  Hello"), prose(0, " world  ")]);

	assert.equal(played(chunks), "Hello world");
	assert.deepEqual(
		chunks.map((chunk) => chunk.whole),
		[true, true],
	);
	assertSameParts(feed, [{ type: "text", text: "  Hello world  " }]);
});

test("whitespace between two deltas of a part is handed on once text follows", () => {
	const feed = new OutputFeed();
	const chunks = deliver(feed, [prose(0, "a"), prose(0, "\n\n"), prose(0, "b")]);

	assert.equal(played(chunks), "a\n\nb");
	assertSameParts(feed, [{ type: "text", text: "a\n\nb" }]);
});

test("whitespace at the end of a part is dropped", () => {
	const feed = new OutputFeed();
	const chunks = deliver(feed, [prose(0, "a  "), prose(0, "  ")]);

	assert.equal(played(chunks), "a");
	assertSameParts(feed, [{ type: "text", text: "a    " }]);
});

test("a run of reasoning is one unit joined by a blank line, and the join is layout", () => {
	const feed = new OutputFeed();
	const chunks = deliver(feed, [reasoning(0, "first"), reasoning(1, "second"), prose(2, "answer")]);

	assert.equal(played(chunks), "first\n\nsecondanswer");
	assert.deepEqual(
		chunks.map((chunk) => chunk.whole),
		[true, false, true, true],
	);
	assertSameParts(feed, [
		{ type: "thinking", thinking: "first" },
		{ type: "thinking", thinking: "second" },
		{ type: "text", text: "answer" },
	]);
});

test("a part of nothing but whitespace is not a part", () => {
	const feed = new OutputFeed();
	const chunks = deliver(feed, [prose(0, "   "), prose(0, "\n")]);

	assert.deepEqual(chunks, []);
	assert.deepEqual(feed.takePartKeys(), []);
});

test("a tool call ends the part before it", () => {
	const feed = new OutputFeed();
	const chunks = deliver(feed, [prose(0, "abc"), CALL, prose(2, "def")]);

	assert.equal(played(chunks), "abcdef");
	assertSameParts(feed, [{ type: "text", text: "abc" }, { type: "toolCall" }, { type: "text", text: "def" }]);
});

test("two prose parts side by side stay two, with nothing between them", () => {
	const feed = new OutputFeed();
	const chunks = deliver(feed, [prose(0, "one"), prose(1, "two")]);

	assert.equal(played(chunks), "onetwo");
	assertSameParts(feed, [{ type: "text", text: "one" }, { type: "text", text: "two" }]);
});

test("reasoning after prose opens a new run, with no blank line into it", () => {
	const feed = new OutputFeed();
	const chunks = deliver(feed, [reasoning(0, "a"), prose(1, "b"), reasoning(2, "c")]);

	assert.equal(played(chunks), "abc");
	assertSameParts(feed, [
		{ type: "thinking", thinking: "a" },
		{ type: "text", text: "b" },
		{ type: "thinking", thinking: "c" },
	]);
});

test("taking the keys empties the list, and a new message starts over", () => {
	const feed = new OutputFeed();
	deliver(feed, [prose(0, "one")]);
	assert.deepEqual(feed.takePartKeys(), [partKey("one")]);
	assert.deepEqual(feed.takePartKeys(), []);

	feed.reset();
	deliver(feed, [reasoning(0, "two")]);
	assert.deepEqual(feed.takePartKeys(), [partKey("two")]);
});

test("reset forgets a part still in progress", () => {
	const feed = new OutputFeed();
	deliver(feed, [prose(0, "half")]);
	feed.reset();

	deliver(feed, [prose(0, "next")]);
	assert.deepEqual(feed.takePartKeys(), [partKey("next")]);
});
