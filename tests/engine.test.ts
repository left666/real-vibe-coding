import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TestContext } from "node:test";

import type { AudioBackend, PlaybackResult } from "../extensions/code-dance/audio.ts";
import { BeatEngine } from "../extensions/code-dance/engine.ts";
import type { Track } from "../extensions/code-dance/library.ts";
import type { PlaylistMode } from "../extensions/code-dance/playlist.ts";
import { endOfTrack, header, noteOn, sequence, tempo, track } from "./smf.ts";

const PPQ = 480;
/** MIDI velocity 100 at 120 BPM spends seven tokens a beat. */
const VELOCITY = 100;

const made: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "code-dance-engine-"));
	made.push(dir);
	return dir;
}

after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** One note at 0s, one at 0.5s, the file ending at 1s. */
function twoOnsets(): Uint8Array {
	return sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, VELOCITY), noteOn(PPQ, 62, VELOCITY), endOfTrack(PPQ)),
	);
}

/** One note at 0s, the file ending at 0.5s. */
function oneOnset(): Uint8Array {
	return sequence(header(0, 1, PPQ), track(tempo(0, 500_000), noteOn(0, 60, VELOCITY), endOfTrack(PPQ)));
}

/** Sixteenth notes at full velocity: eight tokens every eighth of a second, for eight seconds. */
function drumming(): Uint8Array {
	const events: number[][] = [tempo(0, 500_000)];
	for (let index = 0; index < 64; index++) events.push(noteOn(index === 0 ? 0 : 120, 60, 127));
	events.push(endOfTrack(120));
	return sequence(header(0, 1, PPQ), track(...events));
}

function midiTrack(dir: string, name: string, bytes: Uint8Array, withAudio = false): Track {
	const midi = join(dir, `${name}.mid`);
	writeFileSync(midi, bytes);
	if (!withAudio) return { midi };
	const audio = join(dir, `${name}.wav`);
	writeFileSync(audio, "not really audio");
	return { midi, audio };
}

interface Backend extends AudioBackend {
	played: string[];
	stops: { count: number };
}

function silentBackend(): Backend {
	const played: string[] = [];
	const stops = { count: 0 };
	return {
		played,
		stops,
		play(file: string): Promise<PlaybackResult> {
			played.push(file);
			// A player that never finishes: the performance is cut, not ended.
			return new Promise<PlaybackResult>(() => {});
		},
		stop(): void {
			stops.count += 1;
		},
	};
}

function failingBackend(message: string): Backend {
	const played: string[] = [];
	const stops = { count: 0 };
	return {
		played,
		stops,
		play(file: string): Promise<PlaybackResult> {
			played.push(file);
			return Promise.reject(new Error(message));
		},
		stop(): void {
			stops.count += 1;
		},
	};
}

/** Flushes pending microtasks, so the promise chains inside the engine have run. */
function settle(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

interface Rig {
	engine: BeatEngine;
	errors: string[];
	titles: string[];
	handBacks: { count: number };
	views: { count: number };
	clock: { now(): number; tick(ms: number): Promise<void> };
}

function rig(
	t: TestContext,
	options: {
		tracks: readonly Track[];
		backend?: Backend;
		mode?: PlaylistMode;
		loopTrack?: string;
		musicSyncOffsetMs?: number;
	},
): Rig {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

	let ms = 1_000_000;
	const errors: string[] = [];
	const titles: string[] = [];
	const handBacks = { count: 0 };
	const views = { count: 0 };

	const engine = new BeatEngine({
		tracks: options.tracks,
		mode: options.mode ?? "sequential",
		loopTrack: options.loopTrack ?? "",
		musicSyncOffsetMs: options.musicSyncOffsetMs ?? 0,
		backend: options.backend ?? silentBackend(),
		onView: () => {
			views.count += 1;
			const title = engine.view.title;
			if (title !== "" && titles[titles.length - 1] !== title) titles.push(title);
		},
		onError: (message) => errors.push(message),
		onHandBack: () => {
			handBacks.count += 1;
		},
		now: () => ms,
	});

	return {
		engine,
		errors,
		titles,
		handBacks,
		views,
		clock: {
			now: () => ms,
			async tick(delta: number): Promise<void> {
				ms += delta;
				t.mock.timers.tick(delta);
				await settle();
			},
		},
	};
}

/** Tokens `#0` .. `#9`; each is one whole chunk, so one token apiece. */
function chunks(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `#${index}`);
}

/** More queued text than the engine will let the model run ahead of. */
function deepBacklog(engine: BeatEngine): void {
	for (let index = 0; index < 83; index++) engine.feed("x".repeat(30), true);
}

test("a disabled engine keeps its hands off the text", async (t) => {
	const dir = scratch();
	const { engine } = rig(t, { tracks: [midiTrack(dir, "Tune", oneOnset())] });

	engine.setEnabled(false);
	assert.equal(engine.isEnabled, false);
	engine.feed("hello", true);
	assert.equal(engine.queue.total, 0);
	assert.equal(engine.isPlaying, false);

	engine.setEnabled(true);
	assert.equal(engine.isEnabled, true);
	engine.feed("hello", true);
	assert.equal(engine.queue.backlog, 5);
});

test("a task whose last line has printed ends the performance", async (t) => {
	const dir = scratch();
	const backend = silentBackend();
	const { engine, errors, handBacks, clock } = rig(t, {
		tracks: [midiTrack(dir, "First", oneOnset())],
		backend,
	});

	engine.feed("ab", true);
	await settle();

	// The track is open before the first onset: the stage knows what plays.
	assert.equal(engine.isPlaying, true);
	assert.equal(engine.view.title, "First");
	assert.equal(engine.view.bpm, 120);
	assert.equal(engine.view.duration, 0.5);
	assert.equal(engine.view.mode, "sequential");
	assert.deepEqual(errors, []);

	await clock.tick(0);
	assert.equal(engine.queue.printed, "ab");
	assert.equal(engine.queue.isEmpty, true);
	assert.equal(handBacks.count, 0);

	engine.onTaskSettled();
	assert.equal(handBacks.count, 1);
	assert.equal(engine.isPlaying, false);
	assert.equal(engine.view.title, "");
	assert.equal(backend.stops.count, 1);

	// Nothing follows: the performance is over.
	await clock.tick(2_000);
	assert.equal(engine.queue.printed, "");
});

test("text queued before the task ends waits for the onsets, and the task waits for the text", async (t) => {
	const dir = scratch();
	const backend = silentBackend();
	const { engine, handBacks, clock } = rig(t, {
		tracks: [midiTrack(dir, "First", twoOnsets())],
		backend,
	});

	// Ten tokens; a strike at velocity 100 and 120 BPM prints seven of them.
	for (const chunk of chunks(10)) engine.feed(chunk, true);

	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(7).join(""));
	assert.equal(engine.queue.backlog, 6);

	// The task is over, but the print is not: nothing is handed back yet.
	engine.onTaskSettled();
	assert.equal(handBacks.count, 0);
	assert.equal(engine.isPlaying, true);

	await clock.tick(499);
	assert.equal(engine.queue.printed, chunks(7).join(""));

	// The second strike empties the queue, and an empty queue with the task over is
	// the end of the performance: the hand-back is what proves the last tokens went out.
	await clock.tick(1);
	assert.equal(handBacks.count, 1);
	assert.equal(engine.isPlaying, false);
	assert.equal(engine.view.title, "");
	assert.equal(engine.queue.total, 0);
	assert.equal(backend.stops.count, 1);

	// No beat survives the end.
	await clock.tick(2_000);
	assert.equal(engine.queue.total, 0);
	assert.equal(handBacks.count, 1);
});

test("the frames drive the clock readout and the pulse, not the beats", async (t) => {
	const dir = scratch();
	const { engine, views, clock } = rig(t, { tracks: [midiTrack(dir, "First", twoOnsets())] });

	engine.feed("ab", true);
	await settle();

	await clock.tick(250);
	// Beats land on their own timers; the frames interpolate between them.
	assert.ok(engine.view.elapsed > 0.2 && engine.view.elapsed <= 0.25, `elapsed ${engine.view.elapsed}`);
	assert.equal(engine.view.energy, VELOCITY / 127);
	assert.ok(engine.view.pulse > 0);

	await clock.tick(250);
	// The second strike has just landed, so the surge is at full height.
	assert.equal(engine.view.pulse, 1);
	assert.ok(engine.view.elapsed >= 0.49, `elapsed ${engine.view.elapsed}`);
	assert.ok(views.count > 10);
});

test("the sync offset delays the first strike so the print tracks the sound", async (t) => {
	const dir = scratch();
	const { engine, clock } = rig(t, {
		tracks: [midiTrack(dir, "First", oneOnset())],
		musicSyncOffsetMs: 300,
	});

	engine.feed("ab", true);
	await settle();
	assert.equal(engine.view.title, "First");

	await clock.tick(299);
	assert.equal(engine.queue.printed, "");

	await clock.tick(1);
	assert.equal(engine.queue.printed, "ab");
});

test("a track with no recording still keeps time, and the playlist moves on", async (t) => {
	const dir = scratch();
	const { engine, titles, clock } = rig(t, {
		tracks: [midiTrack(dir, "First", twoOnsets()), midiTrack(dir, "Second", twoOnsets())],
	});

	for (const chunk of chunks(10)) engine.feed(chunk, true);
	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(7).join(""));

	// The second strike, then the rest of the first track's length.
	await clock.tick(1_000);
	assert.deepEqual(titles, ["First", "Second"]);

	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(10).join(""));
});

test("the mode in force is carried to the tracks as they open", async (t) => {
	const dir = scratch();
	const first = midiTrack(dir, "First", twoOnsets());
	const second = midiTrack(dir, "Second", twoOnsets());
	const { engine, titles, clock } = rig(t, { tracks: [first, second] });

	engine.configure({ tracks: [first, second], mode: "loop-one", loopTrack: "", musicSyncOffsetMs: 0, backend: silentBackend() });

	engine.feed("ab", true);
	await clock.tick(1_500);

	// Every track open is the first one again.
	assert.deepEqual(titles, ["First"]);
	assert.equal(engine.view.mode, "loop-one");
});

test("sequential carries its place into the next task of a session", async (t) => {
	const dir = scratch();
	const { engine, titles, clock } = rig(t, {
		tracks: [midiTrack(dir, "First", oneOnset()), midiTrack(dir, "Second", oneOnset())],
	});

	engine.feed("ab", true);
	await settle();
	assert.equal(engine.view.title, "First");

	await clock.tick(0);
	assert.equal(engine.queue.printed, "ab");

	engine.onTaskSettled();
	assert.equal(engine.isPlaying, false);

	// The same session's next task takes the next track, not the library's first.
	engine.onTaskStart();
	engine.feed("cd", true);
	await settle();
	assert.equal(engine.view.title, "Second");

	await clock.tick(0);
	assert.equal(engine.queue.printed, "cd");
	assert.deepEqual(titles, ["First", "Second"]);
});

test("loop-one repeats the track the settings choose", async (t) => {
	const dir = scratch();
	const first = midiTrack(dir, "First", oneOnset());
	const second = midiTrack(dir, "Second", oneOnset());
	const { engine, titles, clock } = rig(t, { tracks: [first, second], mode: "loop-one", loopTrack: "Second" });

	engine.feed("ab", true);
	await settle();
	assert.equal(engine.view.title, "Second");

	await clock.tick(0);
	engine.onTaskSettled();
	assert.equal(engine.isPlaying, false);

	// The same one again, task after task.
	engine.onTaskStart();
	engine.feed("cd", true);
	await settle();
	assert.equal(engine.view.title, "Second");
	assert.deepEqual(titles, ["Second"]);
});

test("a chosen track the library does not have falls back to the first", async (t) => {
	const dir = scratch();
	const { engine } = rig(t, {
		tracks: [midiTrack(dir, "First", oneOnset()), midiTrack(dir, "Second", oneOnset())],
		mode: "loop-one",
		loopTrack: "Missing",
	});

	engine.feed("ab", true);
	await settle();
	assert.equal(engine.view.title, "First");
});

test("flush prints the rest at once and ends the performance", async (t) => {
	const dir = scratch();
	const backend = silentBackend();
	const { engine, handBacks, clock } = rig(t, {
		tracks: [midiTrack(dir, "First", twoOnsets())],
		backend,
	});

	for (const chunk of chunks(10)) engine.feed(chunk, true);
	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(7).join(""));

	engine.flush();
	assert.equal(engine.queue.total, 0);
	assert.equal(engine.isPlaying, false);
	assert.equal(engine.view.title, "");
	assert.equal(handBacks.count, 1);
	assert.equal(backend.stops.count, 1);

	// No beat survives the flush.
	await clock.tick(2_000);
	assert.equal(engine.queue.total, 0);
});

test("a request waits only while the printing is far behind", async (t) => {
	const dir = scratch();
	const { engine, clock } = rig(t, { tracks: [midiTrack(dir, "Drumming", drumming())] });

	// Nothing is playing: the model is free to go on.
	await engine.waitForCapacity();

	engine.feed("hello", true);
	await settle();
	await engine.waitForCapacity();

	// A backlog the music cannot print is what holds the model back.
	deepBacklog(engine);
	assert.ok(engine.queue.backlog > 2_400, `backlog ${engine.queue.backlog}`);

	let released = false;
	const parked = engine.waitForCapacity().then(() => {
		released = true;
	});
	await settle();
	assert.equal(released, false);

	// Two onsets print sixteen tokens: still nowhere near caught up.
	await clock.tick(125);
	assert.ok(engine.queue.backlog > 600, `backlog ${engine.queue.backlog}`);
	assert.equal(released, false);

	// Once the printing has caught up, the model is let go.
	await clock.tick(1_400);
	assert.equal(engine.queue.backlog, 0);
	await parked;
	assert.equal(released, true);
});

test("a request parked on the printing is let go when the music stops", async (t) => {
	const dir = scratch();
	const { engine } = rig(t, { tracks: [midiTrack(dir, "Drumming", drumming())] });

	deepBacklog(engine);
	await settle();

	let released = false;
	const parked = engine.waitForCapacity().then(() => {
		released = true;
	});
	await settle();
	assert.equal(released, false);

	engine.stop();
	await parked;
	assert.equal(released, true);
});

test("a track that cannot be read is reported and ends the performance", async (t) => {
	const dir = scratch();
	const broken = join(dir, "Broken.mid");
	writeFileSync(broken, "this is not a midi file");

	const { engine, errors } = rig(t, { tracks: [{ midi: broken }] });
	engine.feed("ab", true);
	await settle();

	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /Broken\.mid/);
	assert.match(errors[0]!, /MThd/);
	assert.equal(engine.isPlaying, false);
});

test("a player that cannot start is reported and ends the performance", async (t) => {
	const dir = scratch();
	const backend = failingBackend("no player here");
	const { engine, errors } = rig(t, {
		tracks: [midiTrack(dir, "First", oneOnset(), true)],
		backend,
	});

	engine.feed("ab", true);
	await settle();

	assert.deepEqual(backend.played, [join(dir, "First.wav")]);
	assert.deepEqual(errors, ["code-dance: no player here"]);
	assert.equal(engine.isPlaying, false);
	assert.equal(backend.stops.count, 1);
});

test("an engine with no tracks says so once", async (t) => {
	const { engine, errors } = rig(t, { tracks: [] });

	engine.feed("ab", true);
	await settle();
	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /曲库为空/);
	assert.equal(engine.isPlaying, false);

	engine.feed("cd", true);
	await settle();
	assert.equal(errors.length, 1);
});

test("reset puts the engine back where it started", async (t) => {
	const dir = scratch();
	const backend = silentBackend();
	const { engine, clock } = rig(t, { tracks: [midiTrack(dir, "First", twoOnsets())], backend });

	engine.feed("ab", true);
	await settle();
	await clock.tick(0);
	assert.equal(engine.queue.printed, "ab");

	engine.reset();
	assert.equal(engine.queue.total, 0);
	assert.equal(engine.isPlaying, false);
	assert.equal(engine.view.title, "");
	assert.equal(engine.view.energy, 0);
	assert.equal(backend.stops.count, 1);

	// Stopping twice is not an error.
	engine.stop();
	assert.equal(backend.stops.count, 2);
});
