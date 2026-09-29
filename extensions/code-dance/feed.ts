/**
 * Turns the assistant's delta stream into text for the stage.
 *
 * The stage is meant to show what the transcript will show once the
 * placeholders are handed back, so this replays `performedParts` on the way in:
 * each part trimmed, a run of adjacent reasoning parts trimmed and joined with
 * a blank line, nothing between any other pair of parts. The whisper of a
 * difference — a part's leading whitespace never reaching the stage, its
 * trailing whitespace only once more text follows inside the same part — comes
 * from the message not existing yet: the trim can only be applied as the text
 * arrives.
 *
 * Every delta is handed on as one whole token, the finest thing the queue may
 * not cut through.
 */

import { partKey } from "./parts.ts";
import type { BeatChunk } from "./queue.ts";

/** The slice of Pi's assistant stream this reads. Structural, so the module stays free of Pi imports. */
export type StreamDelta =
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string };

type BlockKind = "text" | "thinking";

export class OutputFeed {
	/** The part the stream is inside, and its index in the message. */
	private kind: BlockKind | null = null;
	private index: number | null = null;
	/** The part is past its leading trim, so whitespace now means something. */
	private begun = false;
	/** Whitespace held back: dropped when the part ends, handed on once text follows. */
	private held = "";
	/** A reasoning part of this run has been handed on, so the run is open. */
	private runOpen = false;
	/** This part continues a run of reasoning, and owes it a blank line. */
	private owesGap = false;
	/** The unit the transformer is later asked about, as it is being fed. */
	private unit: { kind: BlockKind; text: string } | null = null;
	/** Units that have ended, by key. */
	private readonly sealed: string[] = [];

	push(event: StreamDelta): BeatChunk[] {
		if (event.type === "toolcall_delta") {
			// Tool calls are performed from their execution event, and a call ends
			// the run of reasoning Pi would otherwise render as one block.
			this.clearPart();
			return [];
		}

		const kind: BlockKind = event.type === "text_delta" ? "text" : "thinking";
		if (kind !== this.kind || event.contentIndex !== this.index) {
			// A reasoning block next to another one is the same unit to Pi, joined by a
			// blank line; anything else ends the unit that was open.
			const continuingRun = kind === "thinking" && this.kind === "thinking" && this.runOpen;
			if (!continuingRun) this.sealUnit();
			this.owesGap = continuingRun;
			this.held = "";
			this.begun = false;
			if (kind !== "thinking") this.runOpen = false;
			this.kind = kind;
			this.index = event.contentIndex;
		}

		const incoming = this.held + event.delta;
		this.held = "";
		const body = this.begun ? incoming : incoming.replace(/^\s+/, "");
		const content = body.replace(/\s+$/, "");
		this.held = body.slice(content.length);
		if (content === "") return [];

		const chunks: BeatChunk[] = [];
		if (this.owesGap) {
			this.owesGap = false;
			// Layout, not a token: the queue may cut it anywhere.
			chunks.push({ text: "\n\n", whole: false });
		}
		this.begun = true;
		if (kind === "thinking") this.runOpen = true;
		chunks.push({ text: content, whole: true });

		if (!this.unit || this.unit.kind !== kind) this.unit = { kind, text: "" };
		for (const chunk of chunks) this.unit.text += chunk.text;

		return chunks;
	}

	/**
	 * Close the unit in progress and hand over the keys of every unit this message
	 * performed — what the transformer is asked about once the message is final.
	 */
	takePartKeys(): string[] {
		this.sealUnit();
		const keys = this.sealed.slice();
		this.sealed.length = 0;
		return keys;
	}

	/** A new assistant message restarts the scan. */
	reset(): void {
		this.clearPart();
		this.sealed.length = 0;
	}

	private clearPart(): void {
		this.sealUnit();
		this.kind = null;
		this.index = null;
		this.begun = false;
		this.held = "";
		this.runOpen = false;
		this.owesGap = false;
	}

	/** A unit whose text never arrived (a part of nothing but whitespace) is not a unit. */
	private sealUnit(): void {
		const unit = this.unit;
		this.unit = null;
		if (unit && unit.text !== "") this.sealed.push(partKey(unit.text));
	}
}
