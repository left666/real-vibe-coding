/**
 * The stage: the widget above the editor where the queue is performed.
 *
 * Exactly `stageHeight` rows — a header, the meter, and the tail of the text
 * printed so far. Only the tail: the panel's height is fixed, so a whole task's
 * output can only pass through it, never sit in it. New lines appear at the
 * bottom edge and the older ones slide up out of the panel.
 *
 * The meter is a row of columns that ripple in place. It is full width from the
 * first beat — nothing grows out of one end, nothing scrolls, nothing
 * accumulates; only the heights change. Depth comes from the music: the velocity
 * of the most recent onset sets how tall the wave is, the strike surges it, and
 * it falls back between beats. The wave travels with the tempo, so the row is
 * never still while a track plays.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { StageView } from "./engine.ts";
import type { PlaylistMode } from "./playlist.ts";

/** The header and the meter; the rest of the panel is text. */
const CHROME_ROWS = 2;
const IDLE_HEADER = "♪ 等待输出…";
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
/** Phase per beat. Below one the wave takes more than a beat to pass a column. */
const WAVE_PER_BEAT = 0.9;
const WAVE_PER_SECOND_WHEN_IDLE = 2;

export const MODE_LABELS: Record<PlaylistMode, string> = {
	sequential: "顺序",
	shuffle: "随机",
	"loop-one": "单曲循环",
};

/** `0:42` — a track is minutes long, so the hour is not worth a column. */
export function clock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * One meter row. `travel` is the wave's phase in radians, advancing with the
 * tempo; the columns are a sine of it, offset so neighbours are not in step.
 */
export function meter(view: StageView, width: number, travel: number): string {
	if (width <= 0) return "";
	const depth = clamp01(view.energy);
	const surge = clamp01(view.pulse);
	const top = BARS.length - 1;

	let row = "";
	for (let column = 0; column < width; column++) {
		const phase = column * 0.55 + travel;
		const wave = 0.5 + 0.5 * Math.sin(phase);
		const fine = 0.5 + 0.5 * Math.sin(phase * 0.51 + 1.3);
		// The surge rides on top of the depth, never replacing it: the wave keeps
		// its shape through the strike and only leans taller.
		const level = depth * (0.3 + 0.7 * wave) + surge * 0.3 * (0.35 + 0.65 * fine);
		row += BARS[Math.round(clamp01(level) * top)]!;
	}
	return row;
}

/**
 * The last `rows` display lines of `text`, numbered and wrapped. Each source
 * line carries its number in the gutter; the rows it wraps into do not, so the
 * rule down the middle is unbroken and the eye can tell a wrap from a new line.
 *
 * Only the tail is wrapped — with a whole task's output in `text`, wrapping all
 * of it to show the last ten rows would be work thrown away.
 */
export function tailRows(text: string, width: number, rows: number, paintGutter: (gutter: string) => string): string[] {
	if (rows <= 0 || text === "") return [];

	const source = text.split("\n");
	const digits = String(source.length).length;
	// " 12 │ " — a space, the number, a space, the rule, a space.
	const gutterWidth = digits + 4;
	const body = Math.max(4, width - gutterWidth);
	const continuation = " ".repeat(gutterWidth);

	const collected: { index: number; parts: string[] }[] = [];
	let used = 0;
	for (let index = source.length - 1; index >= 0 && used < rows; index--) {
		const parts = wrapTextWithAnsi(source[index]!, body);
		collected.push({ index, parts });
		used += parts.length;
	}

	const lines: string[] = [];
	for (let at = collected.length - 1; at >= 0; at--) {
		const { index, parts } = collected[at]!;
		for (let part = 0; part < parts.length; part++) {
			const number = part === 0 ? String(index + 1).padStart(digits) : "";
			lines.push((part === 0 ? paintGutter(` ${number} │ `) : continuation) + parts[part]!);
		}
	}
	return lines.slice(-rows);
}

export interface StageOptions {
	view(): StageView;
	text(): string;
	height(): number;
	/** Wall clock in milliseconds; injected by tests. */
	now?: () => number;
}

/** What the rest of the extension drives the widget with. */
export interface Stage {
	/** The panel redraws on the next frame. */
	requestRender(): void;
	/**
	 * Everything redraws, the transcript included — the message components
	 * invalidate and ask their transformers again. This is what puts the real text
	 * back once the performance hands it over.
	 */
	repaint(): void;
	dispose(): void;
}

class StageComponent implements Component {
	private readonly theme: Theme;
	private readonly options: StageOptions;
	private readonly now: () => number;
	private phase = 0;
	private steppedAt: number;
	/** The wrapped tail, reused while the text, the width and the height stand still. */
	private tail: { width: number; rows: number; text: string; lines: string[] } | undefined;

	constructor(theme: Theme, options: StageOptions) {
		this.theme = theme;
		this.options = options;
		this.now = options.now ?? (() => Date.now());
		this.steppedAt = this.now();
	}

	render(width: number): string[] {
		const view = this.options.view();
		const height = Math.max(CHROME_ROWS, Math.floor(this.options.height()));
		const rows = height - CHROME_ROWS;
		const lines: string[] = [];

		if (view.title === "") {
			lines.push(truncateToWidth(this.theme.fg("dim", IDLE_HEADER), width, "", true));
		} else {
			const title = this.theme.bold(this.theme.fg("accent", `♪ ${view.title}`));
			const tempo = this.theme.fg("muted", `${Math.round(view.bpm)} BPM`);
			const time = this.theme.fg("muted", `${clock(view.elapsed)}/${clock(view.duration)}`);
			const mode = this.theme.fg("muted", MODE_LABELS[view.mode]);
			lines.push(truncateToWidth([title, tempo, time, mode].join(this.theme.fg("dim", " · ")), width, "", true));
		}

		lines.push(truncateToWidth(this.theme.fg("accent", meter(view, width, this.travel(view))), width, "", true));

		const tail = this.tailRows(this.options.text(), width, rows);
		// Anchored to the bottom: the newest line is always the panel's last, so
		// the reader's eye has one place to rest while a task prints.
		for (let blank = rows - tail.length; blank > 0; blank--) lines.push("");
		lines.push(...tail);
		return lines;
	}

	invalidate(): void {
		this.tail = undefined;
	}

	private travel(view: StageView): number {
		const now = this.now();
		const speed = view.bpm > 0 ? (view.bpm / 60) * WAVE_PER_BEAT : WAVE_PER_SECOND_WHEN_IDLE;
		this.phase = (this.phase + ((now - this.steppedAt) / 1000) * speed) % (Math.PI * 2);
		this.steppedAt = now;
		return this.phase;
	}

	private tailRows(text: string, width: number, rows: number): string[] {
		const cached = this.tail;
		if (cached && cached.width === width && cached.rows === rows && cached.text === text) return cached.lines;
		const lines = tailRows(text, width, rows, (gutter) => this.theme.fg("dim", gutter));
		this.tail = { width, rows, text, lines };
		return lines;
	}
}

export function installStage(ui: ExtensionUIContext, key: string, options: StageOptions): Stage {
	let tui: TUI | undefined;
	let component: StageComponent | undefined;

	ui.setWidget(key, (withTui, theme) => {
		tui = withTui;
		component = new StageComponent(theme, options);
		return component;
	});

	return {
		requestRender(): void {
			tui?.requestRender();
		},
		repaint(): void {
			// The handle outlives the panel: the transcript lives in the same tree,
			// and handing the text back is exactly what needs repainting.
			component?.invalidate();
			tui?.invalidate();
			tui?.requestRender();
		},
		dispose(): void {
			ui.setWidget(key, undefined);
			component = undefined;
		},
	};
}
