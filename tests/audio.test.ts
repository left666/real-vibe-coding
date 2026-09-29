import assert from "node:assert/strict";
import { test } from "node:test";

import { createAudioBackend, createCommandBackend, createSoundPlayerBackend, parseCommandTemplate } from "../extensions/code-dance/audio.ts";

test("a template is split before the file is put in", () => {
	const { command, args } = parseCommandTemplate('ffplay -nodisp -autoexit "{file}"', "C:\\music\\a.wav");
	assert.equal(command, "ffplay");
	assert.deepEqual(args, ["-nodisp", "-autoexit", "C:\\music\\a.wav"]);
});

test("a path with spaces stays one argument however the template is written", () => {
	const path = "C:\\my music\\night cruising.wav";
	assert.deepEqual(parseCommandTemplate("player {file}", path).args, [path]);
	assert.deepEqual(parseCommandTemplate('player "{file}"', path).args, [path]);
});

test("every {file} is substituted", () => {
	const { args } = parseCommandTemplate("player --in {file} --out {file}.done", "a.wav");
	assert.deepEqual(args, ["--in", "a.wav", "--out", "a.wav.done"]);
});

test("quotes may be single or double, and an empty argument survives", () => {
	assert.deepEqual(parseCommandTemplate("player '' {file}", "a.wav").args, ["", "a.wav"]);
	assert.deepEqual(parseCommandTemplate("player 'a b' {file}", "a.wav").args, ["a b", "a.wav"]);
});

test("an unclosed quote runs to the end of the template", () => {
	assert.deepEqual(parseCommandTemplate('player "a b', "x").args, ["a b"]);
});

test("an empty template is refused", () => {
	assert.throws(() => parseCommandTemplate("", "a.wav"), /empty/);
	assert.throws(() => parseCommandTemplate("   ", "a.wav"), /empty/);
});

test("both backends answer with the same interface", () => {
	for (const backend of [createSoundPlayerBackend(), createCommandBackend("player {file}")]) {
		assert.equal(typeof backend.play, "function");
		assert.equal(typeof backend.stop, "function");
		// Stopping a performance that never started is not an error.
		backend.stop();
	}
});

test("createAudioBackend picks the backend it is asked for", () => {
	assert.equal(typeof createAudioBackend("command", "player {file}").play, "function");
	assert.equal(typeof createAudioBackend("wav-soundplayer", "").play, "function");
});

test("a player that cannot be started rejects", async () => {
	const backend = createCommandBackend("definitely-not-a-real-binary-code-dance {file}");
	await assert.rejects(backend.play("a.wav"));
});

test("playback resolves when the player exits", async () => {
	const backend = createCommandBackend(`"${process.execPath}" -e "" {file}`);
	assert.equal(await backend.play("ignored"), "ended");
});

test("stop cuts a performance short", async () => {
	const backend = createCommandBackend(`"${process.execPath}" -e "setTimeout(() => {}, 10000)"`);
	const playing = backend.play("ignored");
	backend.stop();
	assert.equal(await playing, "stopped");
});
