/**
 * The look-ahead print queue.
 *
 * Text is enqueued the moment the model produces it and printed on the onsets
 * of the track. The queue is what absorbs the difference between the two
 * speeds, in both directions: a deep backlog means the print lags the music,
 * an empty one means it waits for the model while the music plays on.
 *
 * The consumer spends a budget per onset — the music prices it (see `burst`) —
 * and a token is also the finest cut the queue may make. A chunk enqueued
 * `whole` — one provider delta, so one token — always goes out intact, because
 * half a token is not a thing that exists. Text with no tokens to cut on (the
 * line for a tool call, the text of a tool result) is priced at four characters
 * per token and cut wherever the budget runs out.
 *
 * The strongest price is not a count of tokens: those strikes buy the whole line
 * and print to where it ends (`revealLine`), cutting on the line's end instead —
 * a whole chunk included, for there the line, not the token, is the measure.
 *
 * Pure: no timers, no Pi, no I/O.
 */

import type { Onset } from "./midi.ts";

/** How many tokens one onset reveals, at the weakest and at the strongest rate. */
const WEAK_TOKENS_PER_SECOND = 1;
const STRONG_TOKENS_PER_SECOND = WEAK_TOKENS_PER_SECOND * 16;

/** The keyboard's tilt: the same note prints this much more down low than up high, and the other way around. */
const HEAVIEST_PITCH_FACTOR = 2.0;
const LIGHTEST_PITCH_FACTOR = 0.5;

/** The weight a chord reaches as its notes pile up: a bare note weighs 1, a thick chord towards 2. */
const THICKEST_CHORD_FACTOR = 2.0;

/** No note buys more than a bar of printing, however long it is held. */
const LONGEST_COVERED_BEATS = 4;

/**
 * What a line of the panel is worth, in tokens at the usual four characters
 * apiece. A strike that buys this much no longer buys a count: it buys the line
 * itself.
 */
const LINE_BURST_TOKENS = 24;

/** Characters of token-free text that one token of budget buys. */
const CHARS_PER_TOKEN = 4;

/**
 * A "token" far longer than this is not one: some providers coalesce a whole
 * sentence into a single delta, and letting that through intact would dump it
 * on the stage in one jump. Such a chunk is priced and cut like ordinary text.
 */
const LONGEST_WHOLE_CHARS = 32;

export interface BeatChunk {
	text: string;
	/** Printed in one piece: a provider delta, which is one token. */
	whole: boolean;
}

/**
 * What one onset buys: a count of tokens, or — past the token scale — the whole
 * line, whatever its length.
 */
export type Burst = { kind: "tokens"; tokens: number } | { kind: "line" };

/**
 * What this onset buys.
 *
 * The tempo sets the pace per second and the velocity is the accent — the
 * hardest strike prints sixteen times what the weakest one does. What the pace
 * buys is time, and the time is the note's own length: a long note pours out
 * more than a short one, a note the file gives no length for is priced at one
 * beat, and none covers more than a bar. The pitch tilts the price — four to
 * one across the keyboard, twice the base at the bottom of it and half at the
 * top — and the chord weighs on it: a bare note at face value, a thick chord up
 * to twice that, each note it adds weighing less than the one before. Never
 * zero: an onset always moves the print.
 *
 * A budget at the price of a line — the size of a line of the panel — is no
 * longer spent as a count of tokens: past it the onset buys the whole line
 * (`revealLine`).
 */
export function burst(onset: Onset, bpm: number): Burst {
	const secondsPerBeat = 60 / Math.max(1, bpm);
	const covered = Math.min(onset.duration > 0 ? onset.duration : secondsPerBeat, secondsPerBeat * LONGEST_COVERED_BEATS);
	const accent = Math.min(1, Math.max(0, onset.velocity));
	const pitch = Math.min(1, Math.max(0, onset.pitch));
	const tilt = HEAVIEST_PITCH_FACTOR + pitch * (LIGHTEST_PITCH_FACTOR - HEAVIEST_PITCH_FACTOR);
	const weight = THICKEST_CHORD_FACTOR - 1 / Math.max(1, onset.thickness);
	const perSecond = WEAK_TOKENS_PER_SECOND + accent * (STRONG_TOKENS_PER_SECOND - WEAK_TOKENS_PER_SECOND);
	const tokens = Math.max(1, Math.round(perSecond * covered * tilt * weight));
	return tokens >= LINE_BURST_TOKENS ? { kind: "line" } : { kind: "tokens", tokens };
}

export class PrintQueue {
	/** Spent slots stay `undefined` until the whole array is dropped at once. */
	private segments: (BeatChunk | undefined)[] = [];
	/** Index of the segment at the head of the backlog; earlier slots are spent. */
	private head = 0;
	private waiting = 0;
	private printedText = "";

	/** Ready to print, in characters. */
	get backlog(): number {
		return this.waiting;
	}

	/** Characters queued or already printed. Positions into this are how a span is described. */
	get total(): number {
		return this.printedText.length + this.waiting;
	}

	/** Everything that has reached the stage. */
	get printed(): string {
		return this.printedText;
	}

	/** The last character queued or printed, "" when the queue has never held anything. */
	get tail(): string {
		for (let index = this.segments.length - 1; index >= this.head; index--) {
			const segment = this.segments[index];
			if (segment) return segment.text.slice(-1);
		}
		return this.printedText.slice(-1);
	}

	get isEmpty(): boolean {
		return this.waiting === 0;
	}

	/**
	 * Appends a chunk exactly as given — nothing is inserted between chunks. The
	 * queue carries the agent's output, it does not lay it out.
	 */
	push(text: string, whole = false): void {
		if (text === "") return;
		this.segments.push({ text, whole: whole && text.length <= LONGEST_WHOLE_CHARS });
		this.waiting += text.length;
	}

	/**
	 * Move up to `tokens` of budget out of the backlog and onto the stage.
	 * Returns what was printed.
	 */
	reveal(tokens: number): string {
		if (tokens <= 0) return "";

		let budget = tokens;
		let out = "";

		while (budget > 0) {
			const head = this.segments[this.head];
			if (!head) break;

			if (head.whole) {
				// A whole token goes even when the budget cannot hold it — and only
				// the first one: a later one waits for the next onset rather than
				// overrunning this burst.
				if (budget < 1 && out !== "") break;
				out += this.take(head.text.length);
				budget -= 1;
				continue;
			}

			const wanted = Math.min(Math.floor(budget * CHARS_PER_TOKEN), head.text.length);
			if (wanted <= 0) break;
			// Never cut a surrogate pair in half; a lone half renders as a replacement glyph.
			const trailing = head.text.charCodeAt(wanted);
			const take = wanted < head.text.length && trailing >= 0xdc00 && trailing <= 0xdfff ? wanted + 1 : wanted;
			out += this.take(take);
			budget -= take / CHARS_PER_TOKEN;
		}

		this.printedText += out;
		return out;
	}

	/**
	 * Print to the end of the line the cursor stands on: the price the strongest
	 * strikes fetch, where the line, not a token, is the measure. A cursor
	 * standing mid-line has a line to finish before the whole one lands — the
	 * rest of the line it interrupts and the next line come out in one piece.
	 * Text the queue has not received in full prints for what there is of it.
	 */
	revealLine(): string {
		let ends = this.printedText !== "" && !this.printedText.endsWith("\n") ? 2 : 1;
		let out = "";
		while (ends > 0) {
			const head = this.segments[this.head];
			if (!head) break;
			const newline = head.text.indexOf("\n");
			out += this.take(newline < 0 ? head.text.length : newline + 1);
			if (newline >= 0) ends -= 1;
		}
		this.printedText += out;
		return out;
	}

	/** Print everything still waiting. */
	drain(): string {
		let out = "";
		for (let index = this.head; index < this.segments.length; index++) {
			const segment = this.segments[index];
			if (segment) out += segment.text;
		}
		this.segments = [];
		this.head = 0;
		this.waiting = 0;
		this.printedText += out;
		return out;
	}

	reset(): void {
		this.segments = [];
		this.head = 0;
		this.waiting = 0;
		this.printedText = "";
	}

	/** Take `count` characters off the head of the backlog. */
	private take(count: number): string {
		const head = this.segments[this.head]!;
		const text = head.text.slice(0, count);

		if (count >= head.text.length) {
			this.segments[this.head] = undefined;
			this.head += 1;
			if (this.head === this.segments.length) {
				this.segments = [];
				this.head = 0;
			}
		} else {
			this.segments[this.head] = { text: head.text.slice(count), whole: head.whole };
		}

		this.waiting -= count;
		return text;
	}
}
