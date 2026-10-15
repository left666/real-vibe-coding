import assert from "node:assert/strict";
import { test } from "node:test";

import type { Onset } from "../extensions/real-vibe-coding/midi.ts";
import type { Burst } from "../extensions/real-vibe-coding/queue.ts";
import { PrintQueue, burst } from "../extensions/real-vibe-coding/queue.ts";

/** A middle-key strike with no length in the file, the neutral the other cases vary from. */
function onset(velocity: number, overrides: Partial<Onset> = {}): Onset {
	return { seconds: 0, velocity, pitch: 0.5, duration: 0, thickness: 1, ...overrides };
}

/** The tokens a burst bought; only a counted burst has them. */
function tokens(bought: Burst): number {
	if (bought.kind !== "tokens") throw new Error("a whole-line burst has no count");
	return bought.tokens;
}

test("burst: the tempo sets the pace and the accent scales it", () => {
	assert.deepEqual(burst(onset(0), 60), { kind: "tokens", tokens: 1 });
	assert.deepEqual(burst(onset(0.5), 60), { kind: "tokens", tokens: 11 });
	assert.deepEqual(burst(onset(1), 60), { kind: "tokens", tokens: 20 });
	assert.deepEqual(burst(onset(1), 120), { kind: "tokens", tokens: 10 });
	assert.deepEqual(burst(onset(0), 120), { kind: "tokens", tokens: 1 });
	// The accent's spread: the strongest rate prints sixteen times the weakest.
	assert.equal(tokens(burst(onset(1, { pitch: 0 }), 120)), 16 * tokens(burst(onset(0, { pitch: 0 }), 120)));
});

test("burst: a note's own length is the time it buys", () => {
	// At 120 BPM a quarter note is half a second — the beat a lengthless note is priced at.
	assert.deepEqual(burst(onset(1, { duration: 0.5 }), 120), { kind: "tokens", tokens: 10 });
	// A sixteenth buys a quarter of that...
	assert.deepEqual(burst(onset(1, { duration: 0.125 }), 120), { kind: "tokens", tokens: 3 });
	// ...and a note held longer than a bar is still priced at the bar.
	assert.deepEqual(burst(onset(0.5, { duration: 2 }), 120), { kind: "tokens", tokens: 21 });
	assert.deepEqual(burst(onset(0.5, { duration: 30 }), 120), { kind: "tokens", tokens: 21 });
});

test("burst: low notes print heavier than high ones", () => {
	const low = burst(onset(1, { pitch: 0 }), 120);
	const middle = burst(onset(1), 120);
	const high = burst(onset(1, { pitch: 1 }), 120);

	assert.equal(tokens(low), 16);
	assert.equal(tokens(middle), 10);
	assert.equal(tokens(high), 4);
	// The keyboard's spread: four to one, bottom to top.
	assert.equal(tokens(low), tokens(high) * 4);
});

test("burst: a thick chord weighs more than a bare note", () => {
	// The same strike, its notes piling up; each one it adds weighs less.
	assert.deepEqual(burst(onset(1, { thickness: 2 }), 120), { kind: "tokens", tokens: 15 });
	assert.deepEqual(burst(onset(1, { thickness: 4 }), 120), { kind: "tokens", tokens: 18 });
	// The weight nears twice the bare note, however many notes sound.
	assert.deepEqual(burst(onset(1, { thickness: 100 }), 120), { kind: "tokens", tokens: 20 });
});

test("burst: the price of a line buys the whole line, not a count", () => {
	// A whole note at full velocity and a thick half note both outgrow the count...
	assert.deepEqual(burst(onset(1, { duration: 2 }), 120), { kind: "line" });
	assert.deepEqual(burst(onset(1, { duration: 1, thickness: 2 }), 120), { kind: "line" });
	// ...a line's worth — twenty-four tokens — is where the count gives way...
	assert.deepEqual(burst(onset(1, { duration: 1.2 }), 120), { kind: "line" });
	// ...and under it the count still stands.
	assert.deepEqual(burst(onset(1, { duration: 1.1 }), 120), { kind: "tokens", tokens: 22 });
	assert.deepEqual(burst(onset(1, { duration: 1 }), 120), { kind: "tokens", tokens: 20 });
});

test("burst: one onset always moves the print, whatever the numbers", () => {
	// Values outside their ranges are clamped, not extrapolated.
	assert.deepEqual(burst(onset(-5), 60), burst(onset(0), 60));
	assert.deepEqual(burst(onset(9), 60), burst(onset(1), 60));
	assert.deepEqual(burst(onset(1, { pitch: -3 }), 60), burst(onset(1, { pitch: 0 }), 60));
	assert.deepEqual(burst(onset(1, { pitch: 7 }), 60), burst(onset(1, { pitch: 1 }), 60));
	// A negative length is no length: the beat stands in.
	assert.deepEqual(burst(onset(1, { duration: -2 }), 60), burst(onset(1), 60));
	// A chord of no notes weighs what a bare note does.
	assert.deepEqual(burst(onset(1, { thickness: 0 }), 60), burst(onset(1), 60));
	// The weakest strike still moves the print, and a tempo the music cannot have
	// prices as the slowest one it could.
	assert.deepEqual(burst(onset(0), 240), { kind: "tokens", tokens: 1 });
	assert.deepEqual(burst(onset(0), 0), burst(onset(0), 1));
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

test("a line strike prints to the end of the line the cursor stands on", () => {
	const queue = new PrintQueue();
	queue.push("first line\nsecond line\nthird");

	assert.equal(queue.revealLine(), "first line\n");
	// The cursor stands at a line's start: the next strike prints one line, not two.
	assert.equal(queue.revealLine(), "second line\n");
	// A line the queue has not received in full prints for what there is of it.
	assert.equal(queue.revealLine(), "third");
	assert.equal(queue.isEmpty, true);
});

test("a line strike landing mid-line finishes it and takes the next line too", () => {
	const queue = new PrintQueue();
	queue.push("hello world\nnext line\nrest of it");

	assert.equal(queue.reveal(1), "hell");
	assert.equal(queue.revealLine(), "o world\nnext line\n");
	assert.equal(queue.printed, "hello world\nnext line\n");
	assert.equal(queue.backlog, "rest of it".length);
});

test("a line strike reads the lines across the chunks they were pushed in", () => {
	const queue = new PrintQueue();
	queue.push("half of a line ", true);
	queue.push("the rest\nnew", true);

	assert.equal(queue.revealLine(), "half of a line the rest\n");
	assert.equal(queue.revealLine(), "new");
});

test("a line strike with no line end to reach prints all there is", () => {
	const queue = new PrintQueue();
	queue.push("abcdef");

	// Mid-line already, and no line ends anywhere: everything waiting goes out.
	assert.equal(queue.reveal(1), "abcd");
	assert.equal(queue.revealLine(), "ef");
	assert.equal(queue.isEmpty, true);
});

test("a line strike with nothing waiting prints nothing", () => {
	const queue = new PrintQueue();

	assert.equal(queue.revealLine(), "");
	queue.push("abc");
	queue.revealLine();
	assert.equal(queue.revealLine(), "");
});

test("a line end cuts even a whole chunk in two", () => {
	const queue = new PrintQueue();
	queue.push("ab\ncd", true);

	assert.equal(queue.revealLine(), "ab\n");
	// The tail is still the token it was.
	assert.equal(queue.reveal(1), "cd");
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
