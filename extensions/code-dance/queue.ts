/**
 * The look-ahead print queue.
 *
 * Text is enqueued the moment the model produces it and printed on the onsets
 * of the track. The queue is what absorbs the difference between the two
 * speeds, in both directions: a deep backlog means the print lags the music,
 * an empty one means it waits for the model while the music plays on.
 *
 * The consumer spends a budget of tokens per onset, and a token is also the
 * finest cut the queue may make. A chunk enqueued `whole` — one provider
 * delta, so one token — always goes out intact, because half a token is not a
 * thing that exists. Text with no tokens to cut on (the line for a tool call,
 * the text of a tool result) is priced at four characters per token and cut
 * wherever the budget runs out.
 *
 * Pure: no timers, no Pi, no I/O.
 */

/** How many tokens one onset reveals, at the weakest and at the strongest strike. */
const WEAK_TOKENS_PER_SECOND = 2;
const STRONG_TOKENS_PER_SECOND = WEAK_TOKENS_PER_SECOND * 8;

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
 * Tokens this onset may print.
 *
 * The tempo sets the budget per beat and the velocity is the accent — the
 * hardest strike prints eight times what the weakest one does. Never zero: an
 * onset always moves the print.
 */
export function burst(velocity: number, bpm: number): number {
	const accent = Math.min(1, Math.max(0, velocity));
	const perSecond = WEAK_TOKENS_PER_SECOND + accent * (STRONG_TOKENS_PER_SECOND - WEAK_TOKENS_PER_SECOND);
	const secondsPerBeat = 60 / Math.max(1, bpm);
	return Math.max(1, Math.round(perSecond * secondsPerBeat));
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
