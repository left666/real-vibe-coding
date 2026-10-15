import assert from "node:assert/strict";
import { test } from "node:test";

import { OutputFeed } from "../extensions/real-vibe-coding/feed.ts";
import type { FeedChunk, SealedUnit, StreamDelta } from "../extensions/real-vibe-coding/feed.ts";
import { partKey, performedParts } from "../extensions/real-vibe-coding/parts.ts";

interface Delivery {
	chunks: FeedChunk[];
	sealed: SealedUnit[];
}

function deliver(feed: OutputFeed, events: readonly StreamDelta[]): Delivery {
	const chunks: FeedChunk[] = [];
	const sealed: SealedUnit[] = [];
	for (const event of events) {
		const push = feed.push(event);
		chunks.push(...push.chunks);
		sealed.push(...push.sealed);
	}
	return { chunks, sealed };
}

function prose(index: number, delta: string): StreamDelta {
	return { type: "text_delta", contentIndex: index, delta };
}

function reasoning(index: number, delta: string): StreamDelta {
	return { type: "thinking_delta", contentIndex: index, delta };
}

const CALL: StreamDelta = { type: "toolcall_delta", contentIndex: 1, delta: "{}" };

/** Everything that reached the stage, as one string. */
function played(chunks: readonly FeedChunk[]): string {
	return chunks.map((chunk) => chunk.text).join("");
}

/** Every unit the feed sealed, in stream order: what push reported, then what is still open. */
function allSealed(feed: OutputFeed, delivery: Delivery): SealedUnit[] {
	return [...delivery.sealed, ...feed.takeSealed()];
}

/** The parts the feed staged are exactly the parts the transformer will be asked about. */
function assertSameParts(feed: OutputFeed, delivery: Delivery, content: unknown): void {
	assert.deepEqual(
		allSealed(feed, delivery).map((unit) => unit.key),
		performedParts(content).map((part) => partKey(part.text)),
	);
}

test("prose is trimmed the way the finished message will be", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [prose(0, "  Hello"), prose(0, " world  ")]);

	assert.equal(played(delivery.chunks), "Hello world");
	assert.deepEqual(
		delivery.chunks.map((chunk) => chunk.whole),
		[true, true],
	);
	assertSameParts(feed, delivery, [{ type: "text", text: "  Hello world  " }]);
});

test("whitespace between two deltas of a part is handed on once text follows", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [prose(0, "a"), prose(0, "\n\n"), prose(0, "b")]);

	assert.equal(played(delivery.chunks), "a\n\nb");
	assertSameParts(feed, delivery, [{ type: "text", text: "a\n\nb" }]);
});

test("whitespace at the end of a part is dropped", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [prose(0, "a  "), prose(0, "  ")]);

	assert.equal(played(delivery.chunks), "a");
	assertSameParts(feed, delivery, [{ type: "text", text: "a    " }]);
});

test("a run of reasoning is one unit joined by a blank line, and the join is layout", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [reasoning(0, "first"), reasoning(1, "second"), prose(2, "answer")]);

	assert.equal(played(delivery.chunks), "first\n\nsecondanswer");
	assert.deepEqual(
		delivery.chunks.map((chunk) => chunk.whole),
		[true, false, true, true],
	);
	assertSameParts(feed, delivery, [
		{ type: "thinking", thinking: "first" },
		{ type: "thinking", thinking: "second" },
		{ type: "text", text: "answer" },
	]);
});

test("a part of nothing but whitespace is not a part", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [prose(0, "   "), prose(0, "\n")]);

	assert.deepEqual(delivery.chunks, []);
	assert.deepEqual(allSealed(feed, delivery), []);
});

test("a tool call ends the part before it", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [prose(0, "abc"), CALL, prose(2, "def")]);

	assert.equal(played(delivery.chunks), "abcdef");
	assertSameParts(feed, delivery, [
		{ type: "text", text: "abc" },
		{ type: "toolCall" },
		{ type: "text", text: "def" },
	]);
});

test("two prose parts side by side stay two, with nothing between them", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [prose(0, "one"), prose(1, "two")]);

	assert.equal(played(delivery.chunks), "onetwo");
	assertSameParts(feed, delivery, [
		{ type: "text", text: "one" },
		{ type: "text", text: "two" },
	]);
});

test("reasoning after prose opens a new run, with no blank line into it", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [reasoning(0, "a"), prose(1, "b"), reasoning(2, "c")]);

	assert.equal(played(delivery.chunks), "abc");
	assertSameParts(feed, delivery, [
		{ type: "thinking", thinking: "a" },
		{ type: "text", text: "b" },
		{ type: "thinking", thinking: "c" },
	]);
});

test("taking the sealed units empties the list, and a new message starts over", () => {
	const feed = new OutputFeed();
	deliver(feed, [prose(0, "one")]);
	assert.deepEqual(feed.takeSealed(), [{ unit: 1, key: partKey("one") }]);
	assert.deepEqual(feed.takeSealed(), []);

	// Ids are never reused, so a stale queue end can never pair with a new unit.
	feed.reset();
	deliver(feed, [reasoning(0, "two")]);
	assert.deepEqual(feed.takeSealed(), [{ unit: 2, key: partKey("two") }]);
});

test("reset forgets a part still in progress", () => {
	const feed = new OutputFeed();
	deliver(feed, [prose(0, "half")]);
	feed.reset();

	deliver(feed, [prose(0, "next")]);
	assert.deepEqual(feed.takeSealed(), [{ unit: 2, key: partKey("next") }]);
});

test("chunks carry the id of the unit they belong to, and a run shares one", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [reasoning(0, "first"), reasoning(1, "second"), prose(2, "answer")]);

	assert.deepEqual(
		delivery.chunks.map((chunk) => chunk.unit),
		[1, 1, 1, 2],
	);
});

test("an ended unit is sealed with the id its chunks carried", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [prose(0, "one"), prose(1, "two")]);

	assert.deepEqual(delivery.sealed, [{ unit: delivery.chunks[0]!.unit, key: partKey("one") }]);
});

test("a tool call seals the unit it ends", () => {
	const feed = new OutputFeed();
	const delivery = deliver(feed, [prose(0, "abc"), CALL]);

	assert.deepEqual(delivery.sealed, [{ unit: delivery.chunks[0]!.unit, key: partKey("abc") }]);
});
