import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";

import { USER_MUSIC_DIR, bundledMusicDir, collectTracks, userMusicDir } from "../extensions/real-vibe-coding/library.ts";

const made: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "real-vibe-coding-"));
	made.push(dir);
	return dir;
}

after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function touch(path: string): void {
	writeFileSync(path, "");
}

function names(tracks: readonly { midi: string }[]): string[] {
	return tracks.map((track) => basename(track.midi));
}

test("a .mid is paired with its sibling .wav", () => {
	const dir = scratch();
	touch(join(dir, "solo.mid"));
	touch(join(dir, "solo.wav"));
	touch(join(dir, "bare.mid"));

	const tracks = collectTracks([dir]);
	assert.deepEqual(tracks.map((track) => track.audio !== undefined), [false, true]);
	assert.equal(tracks[0]!.audio, undefined);
	assert.equal(tracks[1]!.audio, join(dir, "solo.wav"));
});

test("the pairing ignores case on both sides", () => {
	const dir = scratch();
	touch(join(dir, "Duet.MID"));
	touch(join(dir, "duet.WAV"));

	const tracks = collectTracks([dir]);
	assert.equal(tracks.length, 1);
	assert.equal(tracks[0]!.audio, join(dir, "duet.WAV"));
});

test(".midi works too, and other files are ignored", () => {
	const dir = scratch();
	touch(join(dir, "tune.midi"));
	touch(join(dir, "tune.wav"));
	touch(join(dir, "readme.txt"));
	touch(join(dir, "wavless.mp3"));

	const tracks = collectTracks([dir]);
	assert.equal(tracks.length, 1);
	assert.equal(tracks[0]!.midi, join(dir, "tune.midi"));
});

test("a later directory wins a name collision", () => {
	const first = scratch();
	const second = scratch();
	touch(join(first, "night.mid"));
	touch(join(second, "NIGHT.mid"));
	touch(join(second, "night.wav"));

	const tracks = collectTracks([first, second]);
	assert.equal(tracks.length, 1);
	assert.equal(tracks[0]!.midi, join(second, "NIGHT.mid"));
	assert.equal(tracks[0]!.audio, join(second, "night.wav"));
});

test("a directory that is missing or empty is skipped", () => {
	const dir = scratch();
	assert.deepEqual(collectTracks([join(dir, "nope")]), []);
	assert.deepEqual(collectTracks([""]), []);
	assert.deepEqual(collectTracks([]), []);
	// Directories in the list may be files or nonsense without throwing.
	assert.deepEqual(collectTracks([join(dir, "nope", "deeper")]), []);
});

test("tracks come back sorted by path", () => {
	const dir = scratch();
	for (const name of ["b.mid", "a.mid", "c.mid"]) touch(join(dir, name));

	const tracks = collectTracks([dir]);
	assert.deepEqual(names(tracks), ["a.mid", "b.mid", "c.mid"]);
});

test("the user's directory sits under the agent directory", () => {
	const agent = scratch();
	assert.equal(userMusicDir(agent), join(agent, USER_MUSIC_DIR));
	assert.deepEqual(collectTracks([userMusicDir(agent)]), []);
});

test("the packaged music directory travels with the package", () => {
	const dir = bundledMusicDir();
	assert.notEqual(dir, "");
	assert.match(dir.replaceAll("\\", "/"), /\/music$/);
	assert.equal(bundledMusicDir(), dir);
});
