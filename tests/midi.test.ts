import assert from "node:assert/strict";
import { test } from "node:test";

import { readTimeline } from "../extensions/real-vibe-coding/midi.ts";
import { endOfTrack, header, meta, noteOff, noteOn, sequence, sysex, tempo, track, u32, vlq } from "./smf.ts";

const PPQ = 480;

function close(actual: number, expected: number, tolerance = 1e-6): void {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("one track: onsets land on the beats of the file's own tempo", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 1_000_000), noteOn(0, 60, 64), noteOff(PPQ, 60), noteOn(0, 62, 127), endOfTrack(PPQ)),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.bpm, 60);
	close(timeline.onsets[0]!.seconds, 0);
	close(timeline.onsets[0]!.velocity, 64 / 127);
	close(timeline.onsets[1]!.seconds, 1);
	close(timeline.onsets[1]!.velocity, 1);
	// The end of the rhythm is the last event in the file, not the last note.
	close(timeline.duration, 2);
});

test("a tempo change is followed, and the opening tempo is what the readout shows", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(
			tempo(0, 500_000),
			noteOn(0, 60, 100),
			tempo(PPQ, 250_000),
			noteOn(PPQ, 62, 100),
			endOfTrack(PPQ),
		),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.bpm, 120);
	close(timeline.onsets[0]!.seconds, 0);
	// Half a second for the first beat, then a quarter second each for the beats that follow.
	close(timeline.onsets[1]!.seconds, 0.75);
	// The end-of-track marker sits another quarter after the last note.
	close(timeline.duration, 1);
});

test("a chord is one onset, accented by the hardest strike", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(
			tempo(0, 500_000),
			noteOn(0, 60, 40),
			noteOn(0, 64, 100),
			noteOn(0, 67, 70),
			endOfTrack(),
		),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.onsets.length, 1);
	close(timeline.onsets[0]!.velocity, 100 / 127);
	// The count of notes that folded together is the onset's thickness.
	assert.equal(timeline.onsets[0]!.thickness, 3);
});

test("a note all on its own is a chord of one", () => {
	const file = sequence(header(0, 1, PPQ), track(tempo(0, 500_000), noteOn(0, 60, 100), endOfTrack()));

	assert.equal(readTimeline(file).onsets[0]!.thickness, 1);
});

test("a note carries its pitch and how long it is held", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 64, 100), noteOff(2 * PPQ, 64), endOfTrack()),
	);

	const timeline = readTimeline(file);
	close(timeline.onsets[0]!.pitch, 64 / 127);
	// Two quarter notes at 120 BPM: one second held.
	close(timeline.onsets[0]!.duration, 1);
});

test("a note-on with velocity zero releases the note as well", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, 100), noteOn(PPQ, 60, 0), endOfTrack()),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.onsets.length, 1);
	close(timeline.onsets[0]!.duration, 0.5);
});

test("a note the file never releases is a strike of unknown length", () => {
	const file = sequence(header(0, 1, PPQ), track(tempo(0, 500_000), noteOn(0, 60, 100), endOfTrack(PPQ)));

	const timeline = readTimeline(file);
	close(timeline.onsets[0]!.pitch, 60 / 127);
	close(timeline.onsets[0]!.duration, 0);
});

test("a held note crosses a tempo change at the speeds it lived through", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, 100), tempo(PPQ, 250_000), noteOff(PPQ, 60), endOfTrack()),
	);

	// Half a second at 120 BPM, then a quarter at 240: three quarters of a second.
	close(readTimeline(file).onsets[0]!.duration, 0.75);
});

test("a note struck again while it sounds closes the one before it", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, 100), noteOn(PPQ, 60, 100), noteOff(PPQ, 60), endOfTrack()),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.onsets.length, 2);
	close(timeline.onsets[0]!.duration, 0.5);
	close(timeline.onsets[1]!.duration, 0.5);
});

test("a chord keeps the hardest strike's pitch and length", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(
			tempo(0, 500_000),
			noteOn(0, 48, 40),
			noteOn(0, 72, 100),
			noteOff(PPQ, 72),
			noteOff(PPQ, 48),
			endOfTrack(),
		),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.onsets.length, 1);
	// The hardest strike is the top note, held half a second though the bass rings on.
	close(timeline.onsets[0]!.pitch, 72 / 127);
	close(timeline.onsets[0]!.duration, 0.5);
});

test("notes far enough apart are separate onsets", () => {
	// One beat at 120 BPM is 0.5s, well past the chord window.
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, 100), noteOn(PPQ, 62, 100), endOfTrack()),
	);

	assert.equal(readTimeline(file).onsets.length, 2);
});

test("running status carries the previous status byte", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(
			tempo(0, 500_000),
			noteOn(0, 60, 100),
			// Same status, no status byte repeated: a delta and two data bytes.
			[...vlq(PPQ), 62, 100],
			[...vlq(PPQ), 64, 100],
			endOfTrack(),
		),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.onsets.length, 3);
	close(timeline.onsets[1]!.seconds, 0.5);
	close(timeline.onsets[2]!.seconds, 1);
});

test("format 1 merges the tracks into one order", () => {
	const file = sequence(
		header(1, 2, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, 100), endOfTrack(2 * PPQ)),
		track(noteOn(PPQ, 40, 60), noteOn(PPQ, 43, 60), endOfTrack()),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.bpm, 120);
	assert.deepEqual(
		timeline.onsets.map((onset) => Math.round(onset.seconds * 1000)),
		[0, 500, 1000],
	);
	close(timeline.duration, 1);
});

test("a track with no notes does not stretch the file past the music", () => {
	// The conductor track's writer left its declared end far past the music — it
	// holds the tempo map and nothing to play, so where it ends says nothing.
	const file = sequence(
		header(1, 2, PPQ),
		track(tempo(0, 500_000), endOfTrack(4000 * PPQ)),
		track(noteOn(0, 60, 100), noteOff(PPQ, 60), endOfTrack()),
	);

	close(readTimeline(file).duration, 0.5);
});

test("the declared end of a track that carries the music still counts", () => {
	// Notes stop after half a second, but the music track says its silence runs to
	// two: that is the track's length, trailing silence and all.
	const file = sequence(
		header(1, 2, PPQ),
		track(tempo(0, 500_000), endOfTrack()),
		track(noteOn(0, 60, 100), noteOff(PPQ, 60), endOfTrack(3 * PPQ)),
	);

	close(readTimeline(file).duration, 2);
});

test("a note-on with velocity zero is a note-off", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, 0), noteOn(PPQ, 62, 90), endOfTrack()),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.onsets.length, 1);
	close(timeline.onsets[0]!.seconds, 0.5);
});

test("events the printer does not want are stepped over", () => {
	const file = sequence(
		header(0, 1, PPQ),
		track(
			tempo(0, 500_000),
			sysex(0, [0x7e, 0x7f, 0x09, 0x01]),
			meta(0, 0x03, [..."name"].map((character) => character.charCodeAt(0))),
			[0, 0xc0, 40], // program change: one data byte
			[0, 0xd0, 100], // channel pressure: one data byte
			noteOn(0, 60, 100),
			endOfTrack(),
		),
	);

	const timeline = readTimeline(file);
	assert.equal(timeline.onsets.length, 1);
	close(timeline.onsets[0]!.seconds, 0);
});

test("a file that never sets a tempo runs at 120", () => {
	const file = sequence(header(0, 1, PPQ), track(noteOn(0, 60, 100), noteOn(PPQ, 62, 100), endOfTrack()));

	const timeline = readTimeline(file);
	assert.equal(timeline.bpm, 120);
	close(timeline.onsets[1]!.seconds, 0.5);
});

test("the header may be longer than six bytes", () => {
	const file = sequence(header(0, 1, PPQ, [0, 0]), track(noteOn(0, 60, 100), endOfTrack()));

	assert.equal(readTimeline(file).onsets.length, 1);
});

test("malformed files are refused rather than half-read", () => {
	assert.throws(() => readTimeline(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), /MThd/);
	assert.throws(() => readTimeline(sequence(header(0, 1, 0x8000 | PPQ), track(endOfTrack()))), /SMPTE/);
	assert.throws(() => readTimeline(sequence(header(0, 1, 0), track(endOfTrack()))), /zero ticks/);
	assert.throws(
		() => readTimeline(sequence(header(0, 1, PPQ), [0x4d, 0x54, 0x72, 0x6b, ...u32(99), 0])),
		/runs past the end/,
	);
	assert.throws(() => readTimeline(sequence(header(0, 2, PPQ), track(endOfTrack()))), /missing/);
});

test("a track that ends mid-event is refused", () => {
	// The first chunk's declared length cuts the note's last byte short; the bytes
	// that follow belong to the next chunk, not to this note.
	const bytes = sequence(
		header(1, 2, PPQ),
		[0x4d, 0x54, 0x72, 0x6b, ...u32(3), 0x00, 0x90, 60],
		track(noteOn(0, 62, 100), endOfTrack()),
	);
	assert.throws(() => readTimeline(bytes), /past the end of its chunk/);
});

test("a file with no notes still reports its length and tempo", () => {
	const file = sequence(header(0, 1, PPQ), track(tempo(0, 400_000), endOfTrack(3 * PPQ)));

	const timeline = readTimeline(file);
	assert.equal(timeline.onsets.length, 0);
	assert.equal(timeline.bpm, 150);
	// Three quarter notes at 400ms each.
	close(timeline.duration, 1.2);
});

test("the header's declared track count is respected when extra chunks follow", () => {
	// trackCount says one; the second chunk must be left alone rather than parsed.
	const file = sequence(
		header(0, 1, PPQ),
		track(noteOn(0, 60, 100), endOfTrack()),
		track(noteOn(0, 120, 100), endOfTrack()),
	);

	assert.equal(readTimeline(file).onsets.length, 1);
});

test("a delta time may take three bytes", () => {
	// 16384 ticks — a very late note, but a legal one.
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), [...vlq(16384), 0x90, 60, 100], endOfTrack()),
	);

	close(readTimeline(file).onsets[0]!.seconds, (16384 / PPQ) * 0.5);
});
