import assert from "node:assert/strict";
import { test } from "node:test";

import { ExpansionMirror } from "../extensions/code-dance/expansion.ts";
import type { ToolOutputVisibility } from "../extensions/code-dance/expansion.ts";

/** A `ctx.ui` that watches the flag but can also be changed behind the mirror's back. */
function fakeUi(expanded = false): ToolOutputVisibility & { calls: boolean[]; expanded: boolean } {
	const ui = {
		expanded,
		calls: [] as boolean[],
		getToolsExpanded(): boolean {
			return ui.expanded;
		},
		setToolsExpanded(value: boolean): void {
			ui.calls.push(value);
			ui.expanded = value;
		},
	};
	return ui;
}

test("the block for a running tool is open while its text prints", () => {
	const ui = fakeUi();
	const mirror = new ExpansionMirror(() => ui);

	mirror.open("tool-1", 10);
	mirror.sync(5);
	assert.deepEqual(ui.calls, []);

	mirror.sync(12);
	assert.deepEqual(ui.calls, [true]);

	// Still inside the same tool: no further calls.
	mirror.sync(20);
	assert.deepEqual(ui.calls, [true]);

	// The print has moved past the tool's last character.
	mirror.close("tool-1", 30);
	mirror.sync(29);
	assert.deepEqual(ui.calls, [true]);
	mirror.sync(30);
	assert.deepEqual(ui.calls, [true, false]);
});

test("the block is open for the whole tool run, not only the printed part", () => {
	const ui = fakeUi();
	const mirror = new ExpansionMirror(() => ui);

	mirror.open("tool-1", 10);
	mirror.sync(10);
	mirror.sync(11);
	assert.deepEqual(ui.calls, [true]);

	// Nothing has been printed yet but the tool is still running: the block stays open.
	mirror.sync(10);
	assert.deepEqual(ui.calls, [true]);
});

test("a span whose end is not known yet never folds", () => {
	const ui = fakeUi();
	const mirror = new ExpansionMirror(() => ui);

	mirror.open("tool-1", 0);
	mirror.sync(1_000_000);
	assert.deepEqual(ui.calls, [true]);
});

test("two tools in a row: fold, then open the next", () => {
	const ui = fakeUi();
	const mirror = new ExpansionMirror(() => ui);

	mirror.open("a", 0);
	mirror.close("a", 5);
	mirror.open("b", 10);
	mirror.close("b", 20);

	mirror.sync(3);
	mirror.sync(7);
	mirror.sync(15);
	assert.deepEqual(ui.calls, [true, false, true]);
});

test("nothing reaches the shared flag while there is no ui", () => {
	let ui: (ToolOutputVisibility & { calls: boolean[] }) | undefined;
	const mirror = new ExpansionMirror(() => ui);

	mirror.open("a", 0);
	mirror.close("a", 5);
	mirror.sync(3);

	// The decision was not recorded, so the first sync with a ui acts at once.
	ui = fakeUi();
	mirror.sync(4);
	assert.deepEqual(ui.calls, [true]);
});

test("a reader who keeps tool output expanded never sees it fold", () => {
	const ui = fakeUi(true);
	const mirror = new ExpansionMirror(() => ui);

	mirror.open("a", 0);
	mirror.close("a", 5);
	mirror.sync(3);
	// Nothing to open: the flag is already where the mirror wanted it.
	assert.deepEqual(ui.calls, []);

	mirror.sync(5);
	// And nothing to fold: the mirror never opened this.
	assert.deepEqual(ui.calls, []);
	assert.equal(ui.expanded, true);
});

test("a fold that is already folded is not issued twice", () => {
	const ui = fakeUi();
	const mirror = new ExpansionMirror(() => ui);

	mirror.open("a", 0);
	mirror.close("a", 5);
	mirror.sync(3);
	assert.deepEqual(ui.calls, [true]);

	// The reader folded it by hand.
	ui.expanded = false;
	mirror.sync(6);
	assert.deepEqual(ui.calls, [true]);
});

test("clear folds what the mirror opened and forgets the spans", () => {
	const ui = fakeUi();
	const mirror = new ExpansionMirror(() => ui);

	mirror.open("a", 0);
	mirror.close("a", 5);
	mirror.sync(3);
	assert.deepEqual(ui.calls, [true]);

	mirror.clear();
	assert.deepEqual(ui.calls, [true, false]);

	// The spans are gone; a later sync has nothing to say.
	mirror.sync(3);
	assert.deepEqual(ui.calls, [true, false]);
});

test("a span is half-open: it covers its first character, not its last", () => {
	const ui = fakeUi();
	const mirror = new ExpansionMirror(() => ui);

	mirror.open("a", 10);
	mirror.close("a", 12);
	mirror.sync(9.99);
	assert.deepEqual(ui.calls, []);
	mirror.sync(10);
	assert.deepEqual(ui.calls, [true]);
	mirror.sync(12);
	assert.deepEqual(ui.calls, [true, false]);
});
