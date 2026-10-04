import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

import type { StageView } from "../extensions/code-dance/engine.ts";
import { clock, installStage, meter, tailRows } from "../extensions/code-dance/stage.ts";
import type { StageOptions } from "../extensions/code-dance/stage.ts";

const IDENTITY = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function view(overrides: Partial<StageView> = {}): StageView {
	return { title: "", bpm: 0, elapsed: 0, duration: 0, mode: "sequential", energy: 0, pulse: 0, paused: false, ...overrides };
}

test("clock reads minutes and seconds", () => {
	assert.equal(clock(0), "0:00");
	assert.equal(clock(42.7), "0:42");
	assert.equal(clock(125), "2:05");
	assert.equal(clock(-3), "0:00");
});

test("the meter is one bar per column, and still when there is no music", () => {
	assert.equal(meter(view(), 0, 0), "");

	const row = meter(view(), 30, 0);
	assert.equal(row.length, 30);
	for (const character of row) assert.ok("▁▂▃▄▅▆▇█".includes(character));
	assert.equal(row, "▁".repeat(30));
});

test("the meter's depth is the accent of the last strike", () => {
	const quiet = meter(view({ energy: 0.1 }), 60, 0);
	const loud = meter(view({ energy: 1 }), 60, 0);
	assert.notEqual(quiet, loud);
	assert.ok(loud.includes("█"));
	// Even the weakest strike still shows a shape.
	assert.ok(quiet.includes("▂"));
});

test("a strike surges the meter on top of the depth", () => {
	const betweenBeats = meter(view({ energy: 0.4 }), 60, 1);
	const onTheStrike = meter(view({ energy: 0.4, pulse: 1 }), 60, 1);
	assert.notEqual(betweenBeats, onTheStrike);
});

test("the meter travels with the phase it is given", () => {
	assert.notEqual(meter(view({ energy: 0.5 }), 40, 0), meter(view({ energy: 0.5 }), 40, 1));
});

test("the tail is numbered, wrapped and anonymous on the wraps", () => {
	assert.deepEqual(tailRows("", 20, 5, (gutter) => gutter), []);
	assert.deepEqual(tailRows("hello", 20, 5, (gutter) => gutter), [" 1 │ hello"]);
	assert.deepEqual(tailRows("a", 20, 0, (gutter) => gutter), []);

	const wrapped = tailRows("aaaaaaaaaa", 9, 5, (gutter) => gutter);
	assert.equal(wrapped[0], " 1 │ aaaa");
	assert.equal(wrapped[1], "     aaaa");
	assert.equal(wrapped[2], "     aa");
});

test("the tail keeps only the last rows it was given, wraps included", () => {
	const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
	assert.deepEqual(tailRows(text, 30, 3, (gutter) => gutter), [" 10 │ line 10", " 11 │ line 11", " 12 │ line 12"]);

	// The last source line alone is three rows tall; only the last two fit.
	assert.deepEqual(tailRows("aaaaaaaaaa", 9, 2, (gutter) => gutter), ["     aaaa", "     aa"]);
});

test("the tail numbers lines to the width of the widest number", () => {
	const text = Array.from({ length: 10 }, (_, index) => `x${index + 1}`).join("\n");
	const rows = tailRows(text, 30, 10, (gutter) => gutter);
	assert.equal(rows[0], "  1 │ x1");
	assert.equal(rows[9], " 10 │ x10");
});

test("the gutter is painted by the caller", () => {
	const rows = tailRows("hi", 20, 5, (gutter) => `[${gutter}]`);
	assert.equal(rows[0], "[ 1 │ ]hi");
});

interface Harness {
	stage: { requestRender(): void; repaint(): void; dispose(): void };
	component: Component;
	requests: number[];
	invalidations: number[];
	widgetFactories: Map<string, unknown>;
}

function harness(options: StageOptions): Harness {
	const widgetFactories = new Map<string, unknown>();
	const requests: number[] = [];
	const invalidations: number[] = [];
	const tui = {
		requestRender: () => requests.push(1),
		invalidate: () => invalidations.push(1),
	} as unknown as TUI;
	const ui = {
		setWidget: (key: string, factory: unknown) => void widgetFactories.set(key, factory),
	} as unknown as ExtensionUIContext;

	const stage = installStage(ui, "code-dance", options);
	const factory = widgetFactories.get("code-dance") as (tui: TUI, theme: Theme) => Component;
	return { stage, component: factory(tui, IDENTITY), requests, invalidations, widgetFactories };
}

test("the panel is exactly as tall as the config asks", () => {
	const { component } = harness({ view: () => view(), text: () => "", height: () => 6 });
	const lines = component.render(40);

	assert.equal(lines.length, 6);
	assert.ok(lines[0]!.startsWith("♪ waiting for output…"));
	assert.equal(visibleWidth(lines[0]!), 40);
});

test("the panel never falls below the header and the meter", () => {
	const { component } = harness({ view: () => view(), text: () => "text", height: () => 1 });
	assert.equal(component.render(40).length, 2);
});

test("the header reads the track out", () => {
	const playing = view({ title: "Night Cruising", bpm: 128.4, elapsed: 42, duration: 125, mode: "loop-one" });
	const { component } = harness({ view: () => playing, text: () => "", height: () => 4 });
	const header = component.render(80)[0]!;

	assert.ok(header.includes("♪ Night Cruising"));
	assert.ok(header.includes("128 BPM"));
	assert.ok(header.includes("0:42/2:05"));
	assert.ok(header.includes("loop one"));
});

test("a held performance says so on the header", () => {
	const playing = view({ title: "Tune", paused: true });
	const { component } = harness({ view: () => playing, text: () => "", height: () => 4 });

	const header = component.render(80)[0]!;
	assert.ok(header.includes("⏸ 已暂停"));
	// The track is still named: a pause is not an end.
	assert.ok(header.includes("♪ Tune"));
});

test("the newest line is the panel's last", () => {
	const { component } = harness({ view: () => view({ title: "Tune" }), text: () => "a\nb", height: () => 5 });
	const lines = component.render(20);

	assert.equal(lines.length, 5);
	// Two chrome rows, then the blanks that push the tail down to the last row.
	assert.deepEqual(lines.slice(2), ["", " 1 │ a", " 2 │ b"]);
});

test("the activity line takes a row under the meter, and the tail keeps the bottom", () => {
	const { component } = harness({
		view: () => view({ title: "Tune" }),
		text: () => "a\nb",
		height: () => 6,
		activity: () => "⏳ read a.ts · 3s",
	});
	const lines = component.render(40);

	assert.equal(lines.length, 6);
	assert.equal(lines[2]!.trimEnd(), "⏳ read a.ts · 3s");
	// Three text rows now: a blank, then the tail still at the bottom.
	assert.deepEqual(lines.slice(3), ["", " 1 │ a", " 2 │ b"]);
});

test("an empty activity line leaves the row to the text", () => {
	const { component } = harness({
		view: () => view({ title: "Tune" }),
		text: () => "a\nb",
		height: () => 4,
		activity: () => "",
	});
	const lines = component.render(40);

	assert.equal(lines.length, 4);
	assert.deepEqual(lines.slice(2), [" 1 │ a", " 2 │ b"]);
});

test("the activity line yields when the panel is too short for it", () => {
	const at = (height: number) =>
		harness({
			view: () => view(),
			text: () => "a",
			height: () => height,
			activity: () => "⏳ read a.ts · 3s",
		}).component.render(40);

	// Three rows — the panel's floor — is header, meter and one line of text: the
	// activity row may not take that line.
	const floor = at(3);
	assert.equal(floor.length, 3);
	assert.equal(floor[2], " 1 │ a");

	// One row taller: the wait is named, and the text keeps a row.
	const roomy = at(4);
	assert.equal(roomy.length, 4);
	assert.equal(roomy[2]!.trimEnd(), "⏳ read a.ts · 3s");
	assert.equal(roomy[3], " 1 │ a");
});

test("only the tail of a long text is wrapped into the panel", () => {
	const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
	const { component } = harness({ view: () => view({ title: "Tune" }), text: () => text, height: () => 5 });
	const lines = component.render(30);

	assert.deepEqual(lines.slice(2), [" 48 │ line 48", " 49 │ line 49", " 50 │ line 50"]);
});

test("the meter moves between frames as the clock does", () => {
	let now = 1_000;
	const { component } = harness({
		view: () => view({ title: "Tune", bpm: 120, energy: 0.8 }),
		text: () => "",
		height: () => 4,
		now: () => now,
	});

	const first = component.render(40)[1];
	now += 250;
	const second = component.render(40)[1];
	assert.notEqual(first, second);

	// A frame that does not advance the clock draws the same row.
	assert.equal(second, component.render(40)[1]);
});

test("with no music to move it, the row is still", () => {
	let now = 5_000;
	const { component } = harness({ view: () => view(), text: () => "", height: () => 4, now: () => now });

	const first = component.render(40)[1];
	now += 250;
	assert.equal(first, component.render(40)[1]);
	assert.equal(first, "▁".repeat(40));
});

test("the handle drives the widget and can be disposed", () => {
	const { stage, requests, invalidations, widgetFactories } = harness({
		view: () => view(),
		text: () => "",
		height: () => 4,
	});

	stage.requestRender();
	assert.equal(requests.length, 1);
	stage.repaint();
	assert.equal(invalidations.length, 1);
	assert.equal(requests.length, 2);

	stage.dispose();
	assert.equal(widgetFactories.get("code-dance"), undefined);
	// The handle outlives the panel without throwing.
	stage.requestRender();
	stage.repaint();
});
