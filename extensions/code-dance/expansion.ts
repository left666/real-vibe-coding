/**
 * Mirrors the print queue into Pi's tool-output expansion: the transcript block
 * for a tool is open while the stage is printing that tool's text, and folds
 * back once the print has moved past it.
 *
 * A collapsed block is where the performed text cannot be read in full — Pi
 * cuts it at ten lines and offers `ctrl+o` for the rest — so the one block whose
 * text is on the stage is kept open. Expansion is a single process-wide flag
 * whose setter walks every tool block in the chat, so the mirror only acts when
 * its own state changes, and only folds a block it opened itself: a reader who
 * keeps tool output expanded never sees it close.
 *
 * Positions are queue coordinates: `open` takes the queue's length when a call
 * line is about to be enqueued, `close` the length once the tool's last text is
 * in, and `sync` the number of characters printed so far. A span stays open for
 * the whole tool run, not only for the characters already revealed: the block is
 * the record of the tool being performed.
 *
 * Pure: no Pi, no timers.
 */

/** The slice of `ctx.ui` the mirror drives. */
export interface ToolOutputVisibility {
	getToolsExpanded(): boolean;
	setToolsExpanded(expanded: boolean): void;
}

/** A tool's text in queue coordinates; `end === null` while the tool can still add text. */
interface Span {
	start: number;
	end: number | null;
}

export class ExpansionMirror {
	private readonly resolveUi: () => ToolOutputVisibility | undefined;
	private readonly spans = new Map<string, Span>();
	/** The last decision, so only a change reaches the shared flag. */
	private printing = false;
	/** True while the expansion is the mirror's to fold again. */
	private opened = false;

	constructor(resolveUi: () => ToolOutputVisibility | undefined) {
		this.resolveUi = resolveUi;
	}

	/** A call line for `id` is about to enter the queue at `at`. */
	open(id: string, at: number): void {
		this.spans.set(id, { start: at, end: null });
	}

	/** No more text will come for `id`; the last of it ends at `at`. */
	close(id: string, at: number): void {
		const span = this.spans.get(id);
		if (span) span.end = at;
	}

	/** The queue has printed `position` characters. */
	sync(position: number): void {
		this.apply(this.printingAt(position));
	}

	/** Nothing is being printed any more, and no tool is running. */
	clear(): void {
		this.spans.clear();
		this.apply(false);
	}

	private printingAt(position: number): boolean {
		for (const span of this.spans.values()) {
			if (position >= span.start && (span.end === null || position < span.end)) return true;
		}
		return false;
	}

	private apply(printing: boolean): void {
		// With no ui there is nothing to drive; the decision is not recorded, so
		// the next `sync` acts the moment one exists.
		const ui = this.resolveUi();
		if (!ui) return;
		if (printing === this.printing) return;
		this.printing = printing;

		if (printing) {
			// Someone already keeps them open: folding that later would close a
			// block this mirror never opened.
			if (ui.getToolsExpanded()) return;
			ui.setToolsExpanded(true);
			this.opened = true;
			return;
		}

		if (!this.opened) return;
		this.opened = false;
		if (ui.getToolsExpanded()) ui.setToolsExpanded(false);
	}
}
