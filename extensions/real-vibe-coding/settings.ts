/**
 * `/real-vibe-coding` — the settings list.
 *
 * Every edit goes through `normalizeConfig`, so the panel cannot produce a
 * config that the file loader would have rejected: a number out of range is
 * clamped, a value that is not one of the offered ones falls back to the
 * default, exactly as if the file had held it.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, SelectListTheme, SettingItem, SettingsListTheme, TUI } from "@earendil-works/pi-tui";
import { Box, Input, SelectList, SettingsList, Text } from "@earendil-works/pi-tui";

import type { AudioBackendKind, RealVibeCodingConfig } from "./config.ts";
import { AUDIO_BACKENDS, normalizeConfig } from "./config.ts";
import type { PlaylistMode } from "./playlist.ts";
import { MODE_LABELS } from "./stage.ts";

const ON = "On";
const OFF = "Off";
const MODES: readonly PlaylistMode[] = ["sequential", "shuffle", "loop-one"];
/** The value the panel shows, and the value it writes back, are the same string. */
const HINT = "Enter to confirm · Esc to cancel";
/** Tracks the picker shows at once before it starts scrolling. */
const PICKER_ROWS = 10;

interface Row {
	id: keyof RealVibeCodingConfig;
	label: string;
	description: string;
	/** The current value, as shown and as the edit field starts out. */
	value: (config: RealVibeCodingConfig) => string;
	/** Turn a shown value back into a config. Coercion happens here, once, for both editors. */
	apply: (config: RealVibeCodingConfig, value: string) => RealVibeCodingConfig;
	/** Rows that cycle through these on Enter instead of opening a submenu. */
	values?: readonly string[];
	/** Rows whose submenu is a list of choices to pick among, not an edit field. */
	picker?: boolean;
	/** The kind of field to open when the row has no `values`. */
	input?: "number" | "text";
}

function toggleRow(id: "enabled" | "showPlaceholder", label: string, description: string): Row {
	return {
		id,
		label,
		description,
		values: [ON, OFF],
		value: (config) => (config[id] ? ON : OFF),
		apply: (config, value) => normalizeConfig({ ...config, [id]: value === ON }),
	};
}

function modeOf(label: string): PlaylistMode {
	return MODES.find((mode) => MODE_LABELS[mode] === label) ?? "sequential";
}

/** The loop-one pick: the row opens a second-level list of the track titles. */
function loopRow(names: readonly string[]): Row {
	return {
		id: "loopTrack",
		label: "Loop track",
		description: "The track repeated in loop-one mode.",
		picker: true,
		value: (config) => names.find((name) => name.toLowerCase() === config.loopTrack.toLowerCase()) ?? names[0]!,
		apply: (config, value) => normalizeConfig({ ...config, loopTrack: value }),
	};
}

function rowsFor(names: readonly string[]): Row[] {
	return [
		toggleRow("enabled", "Enabled", "Turn the whole performance off; the transcript renders as usual."),
		{
			id: "playlistMode",
			label: "Playlist mode",
			description: "Which track plays after the current one ends.",
			values: MODES.map((mode) => MODE_LABELS[mode]),
			value: (config) => MODE_LABELS[config.playlistMode],
			apply: (config, value) => normalizeConfig({ ...config, playlistMode: modeOf(value) }),
		},
		...(names.length > 0 ? [loopRow(names)] : []),
		{
			id: "stageHeight",
			label: "Stage height (rows)",
			description: "Rows the stage panel occupies; two of them are the header and the meter.",
			input: "number",
			value: (config) => String(config.stageHeight),
			apply: (config, value) => normalizeConfig({ ...config, stageHeight: Number(value) }),
		},
		toggleRow(
			"showPlaceholder",
			"Placeholders",
			"During a performance, a one-line notice stands in for prose and reasoning in the transcript; the real text returns once it ends.",
		),
		{
			id: "audioBackend",
			label: "Audio backend",
			description: "wav-soundplayer plays .wav via PowerShell; command runs the command template below.",
			values: [...AUDIO_BACKENDS],
			value: (config) => config.audioBackend,
			apply: (config, value) => normalizeConfig({ ...config, audioBackend: value as AudioBackendKind }),
		},
		{
			id: "audioCommand",
			label: "Command template",
			description: "Argv template for the command backend; {file} is replaced with the media path.",
			input: "text",
			value: (config) => config.audioCommand,
			apply: (config, value) => normalizeConfig({ ...config, audioCommand: value }),
		},
	];
}

/** One row's edit field: what is being edited, the input, and — if it does not take — why. */
class EditField implements Component {
	focused = false;

	private readonly theme: Theme;
	private readonly label: string;
	private readonly input = new Input();
	private readonly accept: (raw: string) => string | undefined;
	private readonly done: (value?: string) => void;
	private error = "";

	constructor(
		theme: Theme,
		label: string,
		current: string,
		accept: (raw: string) => string | undefined,
		done: (value?: string) => void,
	) {
		this.theme = theme;
		this.label = label;
		this.accept = accept;
		this.done = done;
		this.input.setValue(current);
		this.input.onSubmit = (raw) => {
			const accepted = this.accept(raw);
			if (accepted === undefined) {
				this.error = `${label}: this value cannot be used`;
				return;
			}
			this.done(accepted);
		};
		this.input.onEscape = () => this.done(undefined);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		return [
			this.theme.fg("accent", this.label),
			...this.input.render(width),
			this.error === "" ? this.theme.fg("dim", HINT) : this.theme.fg("error", this.error),
		];
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

function pickerTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

/**
 * The loop-one pick's second level: the tracks as a list, the one in force
 * already under the cursor. Enter takes the track, Esc keeps the current one.
 */
class TrackPicker implements Component {
	private readonly label: string;
	private readonly hint: string;
	private readonly list: SelectList;

	constructor(theme: Theme, label: string, names: readonly string[], current: string, done: (value?: string) => void) {
		this.label = theme.fg("accent", label);
		this.hint = theme.fg("dim", HINT);
		this.list = new SelectList(
			names.map((name) => ({ value: name, label: name })),
			PICKER_ROWS,
			pickerTheme(theme),
		);
		// The row shows the track in force — the first one when nothing is chosen —
		// so the cursor starts there.
		const at = names.findIndex((name) => name.toLowerCase() === current.toLowerCase());
		this.list.setSelectedIndex(at === -1 ? 0 : at);
		this.list.onSelect = (item) => done(item.value);
		this.list.onCancel = () => done(undefined);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		return [this.label, ...this.list.render(width), this.hint];
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

class Panel implements Component {
	/** True while the panel itself is the TUI's focus. */
	private hasFocus = false;
	private readonly box: Box;
	private readonly list: SettingsList;
	private readonly rows = new Map<string, Row>();
	private config: RealVibeCodingConfig;
	private field: EditField | undefined;

	constructor(
		theme: Theme,
		config: RealVibeCodingConfig,
		names: readonly string[],
		onChange: (config: RealVibeCodingConfig) => void,
		onClose: () => void,
	) {
		this.config = config;

		const items: SettingItem[] = rowsFor(names).map((row) => {
			this.rows.set(row.id, row);
			const item: SettingItem = {
				id: row.id,
				label: row.label,
				description: row.description,
				currentValue: row.value(config),
			};
			if (row.values) item.values = [...row.values];
			else if (row.picker) item.submenu = (current, done) => new TrackPicker(theme, row.label, names, current, done);
			else item.submenu = (current, done) => this.openField(theme, row, current, done);
			return item;
		});

		this.list = new SettingsList(
			items,
			items.length,
			listTheme(theme),
			(id, value) => {
				const row = this.rows.get(id);
				if (!row) return;
				this.config = row.apply(this.config, value);
				onChange(this.config);
			},
			onClose,
		);

		this.box = new Box(1, 1, (line: string) => theme.bg("customMessageBg", line));
		this.box.addChild(new Text(theme.bold(theme.fg("accent", "RealVibeCoding Settings")), 0, 0));
		this.box.addChild(
			new Text(
				theme.fg(
					"dim",
					`${names.length} ${names.length === 1 ? "track" : "tracks"} found (.mid; a same-named .wav plays along)`,
				),
				0,
				0,
			),
		);
		this.box.addChild(new Text("", 0, 0));
		this.box.addChild(this.list);
	}

	/** The edit field draws the cursor, so focus follows the field while one is open. */
	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		if (this.field) this.field.focused = value;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		return this.box.render(width);
	}

	invalidate(): void {
		this.box.invalidate();
	}

	private openField(theme: Theme, row: Row, current: string, done: (value?: string) => void): Component {
		const accept = (raw: string): string | undefined => {
			const text = raw.trim();
			// The one value the config would silently replace: a field left empty, or
			// one that is not a number at all. Better refused than quietly defaulted.
			if (text === "" || (row.input === "number" && !Number.isFinite(Number(text)))) return undefined;
			const next = row.apply(this.config, text);
			return String(next[row.id]);
		};

		const field = new EditField(theme, row.label, current, accept, (value) => {
			this.field = undefined;
			done(value);
		});
		field.focused = this.hasFocus;
		this.field = field;
		return field;
	}
}

function listTheme(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", theme.bold(text)) : theme.fg("text", text)),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "> "),
		hint: (text) => theme.fg("dim", text),
	};
}

export interface SettingsHooks {
	getConfig(): RealVibeCodingConfig;
	/** Titles of the tracks in the library, in play order: the loop-one pick's options. */
	getTrackNames(): readonly string[];
	/** The change is already saved and live when this is called. */
	onConfigChanged(config: RealVibeCodingConfig): void;
}

export function registerSettingsCommand(pi: ExtensionAPI, hooks: SettingsHooks): void {
	pi.registerCommand("real-vibe-coding", {
		description: "Open the RealVibeCoding settings",
		handler: async (_args, ctx: ExtensionContext) => {
			// A list needs a terminal to draw in; the other modes have no panel to open.
			if (ctx.mode !== "tui") return;
			await ctx.ui.custom<void>(
				(_tui: TUI, theme, _keybindings, done) => {
					const panel = new Panel(
						theme,
						hooks.getConfig(),
						hooks.getTrackNames(),
						(config) => hooks.onConfigChanged(config),
						() => done(undefined),
					);
					return {
						get focused(): boolean {
							return panel.focused;
						},
						set focused(value: boolean) {
							panel.focused = value;
						},
						render: (width: number) => panel.render(width),
						invalidate: () => panel.invalidate(),
						handleInput: (data: string) => panel.handleInput(data),
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: 72, minWidth: 40, margin: 2 } },
			);
		},
	});
}
