import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import type { CodeDanceConfig } from "../extensions/code-dance/config.ts";
import { DEFAULT_CONFIG } from "../extensions/code-dance/config.ts";
import { registerSettingsCommand } from "../extensions/code-dance/settings.ts";

const THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_color: string, text: string) => text,
} as unknown as Theme;

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

interface Opened {
	panel: Component;
	/** What the panel handed to `onConfigChanged`, in order. */
	changes: CodeDanceConfig[];
}

/** Open the panel the way the command does, and hand back the component to drive. */
async function open(config: CodeDanceConfig, names: readonly string[]): Promise<Opened> {
	const changes: CodeDanceConfig[] = [];
	let handler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	registerSettingsCommand(
		{
			registerCommand: (_name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
				void (handler = spec.handler),
		} as never,
		{
			getConfig: () => config,
			getTrackNames: () => names,
			onConfigChanged: (next) => void changes.push(next),
		},
	);

	let panel: Component | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (
				factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (value?: unknown) => void) => Component,
			) => {
				panel = factory({} as TUI, THEME, {}, () => {});
			},
		},
	} as unknown as ExtensionContext;

	await handler!("", ctx);
	assert.ok(panel, "the panel opened");
	return { panel, changes };
}

const screen = (panel: Component): string => panel.render(72).join("\n");

/** `Component.handleInput` is optional; the panel always has one. */
function press(panel: Component, key: string): void {
	panel.handleInput?.(key);
}

/** Down twice from the top: `enabled`, `playlistMode`, then the loop pick. */
function toLoopRow(panel: Component): void {
	press(panel, DOWN);
	press(panel, DOWN);
}

test("the loop row opens a second-level list and takes the chosen track", async () => {
	const { panel, changes } = await open({ ...DEFAULT_CONFIG }, ["Alpha", "Beta", "Gamma"]);

	// The row shows the track in force: the first one, with nothing chosen yet.
	assert.match(screen(panel), /循环曲目\s+Alpha/);

	toLoopRow(panel);
	press(panel, ENTER);

	// The picker is the second level: the tracks as a list with the first one
	// under the cursor, and none of the first level's other rows on it.
	const picker = screen(panel);
	assert.match(picker, /→ Alpha/);
	assert.match(picker, /Beta/);
	assert.doesNotMatch(picker, /舞台高度/);

	press(panel, DOWN);
	assert.match(screen(panel), /→ Beta/);

	press(panel, ENTER);
	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.loopTrack, "Beta");

	// Back on the first level, the row now shows the track that was chosen.
	assert.match(screen(panel), /循环曲目\s+Beta/);
});

test("the picker starts on the track in force and Esc keeps it", async () => {
	const { panel, changes } = await open({ ...DEFAULT_CONFIG, loopTrack: "Gamma" }, ["Alpha", "Beta", "Gamma"]);

	toLoopRow(panel);
	press(panel, ENTER);
	assert.match(screen(panel), /→ Gamma/);

	press(panel, ESC);
	assert.equal(changes.length, 0);
	assert.match(screen(panel), /循环曲目\s+Gamma/);
});

test("with no tracks there is no loop row to open", async () => {
	const { panel } = await open({ ...DEFAULT_CONFIG }, []);
	assert.doesNotMatch(screen(panel), /循环曲目/);
});
