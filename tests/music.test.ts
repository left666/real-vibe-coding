import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";

import { bundledMusicDir, collectTracks } from "../extensions/code-dance/library.ts";
import { readTimeline } from "../extensions/code-dance/midi.ts";

/** The tracks that ship with the package are the ones a first run performs. */
const tracks = collectTracks([bundledMusicDir()]);

test("the package ships at least one track", () => {
	assert.ok(tracks.length >= 1, `no music under ${bundledMusicDir()}`);
});

test("every shipped track is a .mid with its .wav beside it", () => {
	for (const track of tracks) {
		assert.ok(track.audio !== undefined, `${basename(track.midi)} has no .wav beside it`);
		assert.match(track.midi, /\.midi?$/);
		assert.match(track.audio!, /\.wav$/);
	}
});

test("every shipped rhythm reads as a timeline the printer can follow", () => {
	for (const track of tracks) {
		const timeline = readTimeline(readFileSync(track.midi));
		const name = basename(track.midi);

		assert.ok(timeline.bpm > 20 && timeline.bpm < 400, `${name}: bpm ${timeline.bpm}`);
		assert.ok(timeline.duration > 10, `${name}: duration ${timeline.duration}`);
		assert.ok(timeline.onsets.length > 16, `${name}: ${timeline.onsets.length} onsets`);

		let previous = -1;
		for (const onset of timeline.onsets) {
			assert.ok(onset.seconds >= previous, `${name}: onsets are not sorted`);
			// Anything closer than the chord window was folded into its neighbour.
			assert.ok(previous < 0 || onset.seconds - previous >= 0.03 - 1e-9, `${name}: onsets are not folded`);
			previous = onset.seconds;
			assert.ok(onset.velocity > 0 && onset.velocity <= 1, `${name}: velocity ${onset.velocity}`);
			assert.ok(onset.pitch >= 0 && onset.pitch <= 1, `${name}: pitch ${onset.pitch}`);
			assert.ok(onset.duration >= 0, `${name}: duration ${onset.duration}`);
		}
	}
});
