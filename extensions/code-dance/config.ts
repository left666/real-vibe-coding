/**
 * `~/.pi/agent/code-dance.json`.
 *
 * The file is user input, so every field is validated here and the rest of the
 * extension can assume a well-formed config. The agent directory is passed in
 * rather than imported, which keeps this module testable without Pi.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PLAYLIST_MODES } from "./playlist.ts";
import type { PlaylistMode } from "./playlist.ts";

export type AudioBackendKind = "wav-soundplayer" | "command";

export const AUDIO_BACKENDS: readonly AudioBackendKind[] = ["wav-soundplayer", "command"];

export interface CodeDanceConfig {
	/** Off: nothing is performed and the transcript renders as usual. */
	enabled: boolean;
	playlistMode: PlaylistMode;
	/** The title of the track loop-one repeats; "" is the library's first. */
	loopTrack: string;
	/** Rows the stage panel occupies, the header and the meter included. */
	stageHeight: number;
	/** Stand in for performed prose and reasoning with a one-line notice. */
	showPlaceholder: boolean;
	audioBackend: AudioBackendKind;
	/** Whitespace-split argv template; `{file}` becomes the media path. */
	audioCommand: string;
	/**
	 * Added to the playback clock to absorb the player's process-start latency.
	 * A calibration rather than a preference, so it has no row in the panel.
	 */
	musicSyncOffsetMs: number;
}

export const CONFIG_FILE = "code-dance.json";

export const DEFAULT_CONFIG: CodeDanceConfig = {
	enabled: true,
	playlistMode: "sequential",
	loopTrack: "",
	stageHeight: 12,
	showPlaceholder: true,
	audioBackend: process.platform === "win32" ? "wav-soundplayer" : "command",
	audioCommand: 'ffplay -nodisp -autoexit "{file}"',
	musicSyncOffsetMs: 300,
};

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function asInt(value: unknown, low: number, high: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(high, Math.max(low, Math.round(value)));
}

function asMode(value: unknown): PlaylistMode {
	return PLAYLIST_MODES.includes(value as PlaylistMode) ? (value as PlaylistMode) : DEFAULT_CONFIG.playlistMode;
}

function asBackend(value: unknown): AudioBackendKind {
	return AUDIO_BACKENDS.includes(value as AudioBackendKind)
		? (value as AudioBackendKind)
		: DEFAULT_CONFIG.audioBackend;
}

/** Coerce anything into a usable config — used on load and on every panel edit alike. */
export function normalizeConfig(raw: unknown): CodeDanceConfig {
	const source =
		typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

	return {
		enabled: asBoolean(source.enabled, DEFAULT_CONFIG.enabled),
		playlistMode: asMode(source.playlistMode),
		loopTrack: asString(source.loopTrack, DEFAULT_CONFIG.loopTrack),
		// Three rows is the panel's own floor: header, meter, one line of text.
		stageHeight: asInt(source.stageHeight, 3, 60, DEFAULT_CONFIG.stageHeight),
		showPlaceholder: asBoolean(source.showPlaceholder, DEFAULT_CONFIG.showPlaceholder),
		audioBackend: asBackend(source.audioBackend),
		audioCommand: asString(source.audioCommand, DEFAULT_CONFIG.audioCommand),
		musicSyncOffsetMs: asInt(source.musicSyncOffsetMs, -5000, 5000, DEFAULT_CONFIG.musicSyncOffsetMs),
	};
}

/** Write the default file on first run, so there is something to edit. */
export function ensureConfigFile(agentDir: string): void {
	const path = configPath(agentDir);
	if (existsSync(path)) return;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
	} catch {
		// Best effort: a config that cannot be written just means defaults.
	}
}

export function loadConfig(
	agentDir: string,
	warn?: (message: string, level: "warning" | "info") => void,
): CodeDanceConfig {
	const path = configPath(agentDir);
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };

	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		warn?.(`code-dance: 配置无法解析（${error instanceof Error ? error.message : String(error)}），已用默认值`, "warning");
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(agentDir: string, config: CodeDanceConfig): void {
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(configPath(agentDir), `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch {
		// Best effort: the panel still applies the change for this session.
	}
}
