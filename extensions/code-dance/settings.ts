/**
 * `/code-dance` — the settings list.
 *
 * Every edit goes through `normalizeConfig`, so the panel cannot produce a
 * config that the file loader would have rejected: a number out of range is
 * clamped, a value that is not one of the offered ones falls back to the
 * default, exactly as if the file had held it.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, SettingItem, SettingsListTheme, TUI } from "@earendil-works/pi-tui";
import { Box, Input, SettingsList, Text } from "@earendil-works/pi-tui";

import type { AudioBackendKind, CodeDanceConfig } from "./config.ts";
import { AUDIO_BACKENDS, normalizeConfig } from "./config.ts";
import type { PlaylistMode } from "./playlist.ts";
import { MODE_LABELS } from "./stage.ts";

const ON = "开启";
const OFF = "关闭";
const MODES: readonly PlaylistMode[] = ["sequential", "shuffle", "loop-one"];
/** The value the panel shows, and the value it writes back, are the same string. */
const HINT = "Enter 确认 · Esc 取消";

interface Row {
	id: keyof CodeDanceConfig;
	label: string;
	description: string;
	/** The current value, as shown and as the edit field starts out. */
	value: (config: CodeDanceConfig) => string;
	/** Turn a shown value back into a config. Coercion happens here, once, for both editors. */
	apply: (config: CodeDanceConfig, value: string) => CodeDanceConfig;
	/** Rows that cycle through these instead of opening a field. */
	values?: readonly string[];
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

const ROWS: readonly Row[] = [
	toggleRow("enabled", "启用", "关闭整个演出，代码恢复为正常渲染。"),
	{
		id: "playlistMode",
		label: "播放模式",
		description: "一首放完之后接着放哪一首。",
		values: MODES.map((mode) => MODE_LABELS[mode]),
		value: (config) => MODE_LABELS[config.playlistMode],
		apply: (config, value) => normalizeConfig({ ...config, playlistMode: modeOf(value) }),
	},
	{
		id: "stageHeight",
		label: "舞台高度（行）",
		description: "舞台面板占用的行数，其中两行是标题和力度条。",
		input: "number",
		value: (config) => String(config.stageHeight),
		apply: (config, value) => normalizeConfig({ ...config, stageHeight: Number(value) }),
	},
	toggleRow("showPlaceholder", "保留占位行", "演出时在会话记录里用一行占位提示顶替正文和思考，演出结束后变回正文。"),
	{
		id: "audioBackend",
		label: "音频后端",
		description: "wav-soundplayer 用 PowerShell 播放 .wav；command 执行下面的命令模板。",
		values: [...AUDIO_BACKENDS],
		value: (config) => config.audioBackend,
		apply: (config, value) => normalizeConfig({ ...config, audioBackend: value as AudioBackendKind }),
	},
	{
		id: "audioCommand",
		label: "命令模板",
		description: "command 后端的 argv 模板，其中 {file} 会替换成媒体路径。",
		input: "text",
		value: (config) => config.audioCommand,
		apply: (config, value) => normalizeConfig({ ...config, audioCommand: value }),
	},
];

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
				this.error = `${label}：这个值不能用`;
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

class Panel implements Component {
	/** True while the panel itself is the TUI's focus. */
	private hasFocus = false;
	private readonly box: Box;
	private readonly list: SettingsList;
	private readonly rows = new Map<string, Row>();
	private config: CodeDanceConfig;
	private field: EditField | undefined;

	constructor(
		theme: Theme,
		config: CodeDanceConfig,
		trackCount: number,
		onChange: (config: CodeDanceConfig) => void,
		onClose: () => void,
	) {
		this.config = config;

		const items: SettingItem[] = ROWS.map((row) => {
			this.rows.set(row.id, row);
			const item: SettingItem = {
				id: row.id,
				label: row.label,
				description: row.description,
				currentValue: row.value(config),
			};
			if (row.values) item.values = [...row.values];
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
		this.box.addChild(new Text(theme.bold(theme.fg("accent", "CodeDance 设置")), 0, 0));
		this.box.addChild(new Text(theme.fg("dim", `已找到 ${trackCount} 首（.mid，同名 .wav 一并播放）`), 0, 0));
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
	getConfig(): CodeDanceConfig;
	getTrackCount(): number;
	/** The change is already saved and live when this is called. */
	onConfigChanged(config: CodeDanceConfig): void;
}

export function registerSettingsCommand(pi: ExtensionAPI, hooks: SettingsHooks): void {
	pi.registerCommand("code-dance", {
		description: "Open the CodeDance settings",
		handler: async (_args, ctx: ExtensionContext) => {
			// A list needs a terminal to draw in; the other modes have no panel to open.
			if (ctx.mode !== "tui") return;
			await ctx.ui.custom<void>(
				(_tui: TUI, theme, _keybindings, done) => {
					const panel = new Panel(
						theme,
						hooks.getConfig(),
						hooks.getTrackCount(),
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
