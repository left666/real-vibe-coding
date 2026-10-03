/**
 * The music library: the tracks that ship with the package, plus whatever the
 * user drops under the agent directory.
 *
 * `.mid` supplies the rhythm, `.wav` the sound, and the two are expected to be
 * the same performance — the print follows the MIDI's onsets while the audio
 * plays, so a pair that does not line up drifts apart as the track goes.
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Track {
	/** Absolute path to the `.mid` that supplies the rhythm. */
	midi: string;
	/** Sibling `.wav` of the same name, when there is one. */
	audio?: string;
}

/** `Night Cruising.mid` -> `Night Cruising`: the name the stage and the settings show. */
export function trackTitle(midiPath: string): string {
	const name = basename(midiPath);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

const MIDI_EXTENSIONS = [".mid", ".midi"] as const;

/** Where a user adds tracks of their own, under the agent directory. */
export const USER_MUSIC_DIR = "code-dance/music";

export function userMusicDir(agentDir: string): string {
	return join(agentDir, "code-dance", "music");
}

/** `<package>/music`, resolved from this module so it travels with the package. */
export function bundledMusicDir(): string {
	try {
		return fileURLToPath(new URL("../../music", import.meta.url));
	} catch {
		// Only a pathological URL layout lands here; the user directory still works.
		return "";
	}
}

/**
 * `.mid`/`.midi` files in each directory, each paired with a sibling `.wav`
 * when one exists. A later directory wins a name collision, so a track the user
 * puts in the agent directory takes the place of the packaged one.
 */
export function collectTracks(dirs: readonly string[]): Track[] {
	const found = new Map<string, Track>();

	for (const dir of dirs) {
		if (dir === "") continue;

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}

		const lowercased = new Map(entries.map((name) => [name.toLowerCase(), name]));
		for (const name of entries) {
			const extension = MIDI_EXTENSIONS.find((candidate) => name.toLowerCase().endsWith(candidate));
			if (!extension) continue;

			const stem = name.slice(0, -extension.length);
			const audio = lowercased.get(`${stem.toLowerCase()}.wav`);
			found.set(stem.toLowerCase(), {
				midi: join(dir, name),
				audio: audio ? join(dir, audio) : undefined,
			});
		}
	}

	return [...found.values()].sort((a, b) => a.midi.localeCompare(b.midi));
}
