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
 * not cut through. Each chunk carries the id of the unit it belongs to, and a
 * sealed unit hands over the same id beside the key the transformer will ask
 * about — together they let the caller record where in the queue a part ends
 * and swap it back the moment the printing passes that point.
 */

import { partKey } from "./parts.ts";
import type { BeatChunk } from "./queue.ts";

/** The slice of Pi's assistant stream this reads. Structural, so the module stays free of Pi imports. */
export type StreamDelta =
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string };

type BlockKind = "text" | "thinking";

/** A chunk bound to the unit it is part of, so the caller can follow its queue span. */
export interface FeedChunk extends BeatChunk {
	unit: number;
}

/** A unit the feed is done with: its id, and the key the transformer will ask about. */
export interface SealedUnit {
	unit: number;
	key: string;
}

export interface FeedPush {
	chunks: FeedChunk[];
	/** Units that ended in this push — the caller resolves their queue ends while the ids are fresh. */
	sealed: SealedUnit[];
}

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
	/** The unit being fed, under the id the caller tracks it by. Ids are never reused. */
	private unit: { id: number; text: string } | null = null;
	private nextUnit = 1;

	push(event: StreamDelta): FeedPush {
		const chunks: FeedChunk[] = [];
		const sealed: SealedUnit[] = [];

		if (event.type === "toolcall_delta") {
			// Tool calls are performed from their execution event, and a call ends
			// the run of reasoning Pi would otherwise render as one block.
			this.sealUnit(sealed);
			this.releasePart();
			return { chunks, sealed };
		}

		const kind: BlockKind = event.type === "text_delta" ? "text" : "thinking";
		if (kind !== this.kind || event.contentIndex !== this.index) {
			// A reasoning block next to another one is the same unit to Pi, joined by a
			// blank line; anything else ends the unit that was open.
			const continuingRun = kind === "thinking" && this.kind === "thinking" && this.runOpen;
			if (!continuingRun) this.sealUnit(sealed);
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
		if (content === "") return { chunks, sealed };

		if (!this.unit) this.unit = { id: this.nextUnit++, text: "" };
		const unit = this.unit;

		if (this.owesGap) {
			this.owesGap = false;
			// Layout, not a token: the queue may cut it anywhere.
			chunks.push({ text: "\n\n", whole: false, unit: unit.id });
		}
		this.begun = true;
		if (kind === "thinking") this.runOpen = true;
		chunks.push({ text: content, whole: true, unit: unit.id });

		for (const chunk of chunks) unit.text += chunk.text;
		return { chunks, sealed };
	}

	/**
	 * Close the unit in progress and hand over every unit that left the stream
	 * since the last take — what the transformer is asked about once the message
	 * is final.
	 */
	takeSealed(): SealedUnit[] {
		const sealed: SealedUnit[] = [];
		this.sealUnit(sealed);
		return sealed;
	}

	/** A new assistant message restarts the scan. */
	reset(): void {
		this.unit = null;
		this.releasePart();
	}

	/** A unit whose text never arrived (a part of nothing but whitespace) is not a unit. */
	private sealUnit(out: SealedUnit[]): void {
		const unit = this.unit;
		this.unit = null;
		if (unit && unit.text !== "") out.push({ unit: unit.id, key: partKey(unit.text) });
	}

	private releasePart(): void {
		this.kind = null;
		this.index = null;
		this.begun = false;
		this.held = "";
		this.runOpen = false;
		this.owesGap = false;
	}
}
