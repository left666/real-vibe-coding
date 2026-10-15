import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TestContext } from "node:test";

import type { AudioBackend, PlaybackResult } from "../extensions/real-vibe-coding/audio.ts";
import { BeatEngine } from "../extensions/real-vibe-coding/engine.ts";
import type { Track } from "../extensions/real-vibe-coding/library.ts";
import type { PlaylistMode } from "../extensions/real-vibe-coding/playlist.ts";
import { endOfTrack, header, noteOff, noteOn, sequence, tempo, track } from "./smf.ts";

const PPQ = 480;
/** MIDI velocity 100 at 120 BPM spends eight tokens a beat. */
const VELOCITY = 100;

const made: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "real-vibe-coding-engine-"));
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

/** Sixteenth notes at full velocity: three tokens on every sixteenth, for eight seconds. */
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

/**
 * A player that honours the backend contract: `play` settles when `stop` cuts it
 * short. The pause leans on that — it is the kill that ends the current track's
 * await, and the loop then waits for the resume.
 */
function honestBackend(): Backend {
	const played: string[] = [];
	const stops = { count: 0 };
	let ended: ((result: PlaybackResult) => void) | null = null;
	return {
		played,
		stops,
		play(file: string): Promise<PlaybackResult> {
			played.push(file);
			return new Promise<PlaybackResult>((resolve) => {
				ended = resolve;
			});
		},
		stop(): void {
			stops.count += 1;
			ended?.("stopped");
			ended = null;
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

	// Ten chunks; a strike at velocity 100 and 120 BPM prints eight of them.
	for (const chunk of chunks(10)) engine.feed(chunk, true);

	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(8).join(""));
	assert.equal(engine.queue.backlog, 4);

	// The task is over, but the print is not: nothing is handed back yet.
	engine.onTaskSettled();
	assert.equal(handBacks.count, 0);
	assert.equal(engine.isPlaying, true);

	await clock.tick(499);
	assert.equal(engine.queue.printed, chunks(8).join(""));

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

test("the view carries the pitch of the last strike", async (t) => {
	const dir = scratch();
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 40, VELOCITY), noteOn(PPQ, 88, VELOCITY), endOfTrack(PPQ)),
	);
	const { engine, clock } = rig(t, { tracks: [midiTrack(dir, "First", file)] });

	engine.feed("ab", true);
	await settle();
	await clock.tick(0);
	assert.equal(engine.view.pitch, 40 / 127);

	await clock.tick(500);
	assert.equal(engine.view.pitch, 88 / 127);
});

test("a short note's surge is spent quickly", async (t) => {
	const dir = scratch();
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, VELOCITY), noteOff(PPQ / 4, 60), endOfTrack(8 * PPQ)),
	);
	const { engine, clock } = rig(t, { tracks: [midiTrack(dir, "Short", file)] });

	engine.feed("ab", true);
	await settle();
	await clock.tick(0);
	assert.equal(engine.view.pulse, 1);

	// A sixteenth at 120 BPM is 125ms: the surge is gone well before this.
	await clock.tick(600);
	assert.equal(engine.view.pulse, 0);
});

test("a long note rides its surge out", async (t) => {
	const dir = scratch();
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, VELOCITY), noteOff(4 * PPQ, 60), endOfTrack(8 * PPQ)),
	);
	const { engine, clock } = rig(t, { tracks: [midiTrack(dir, "Long", file)] });

	engine.feed("ab", true);
	await settle();
	await clock.tick(0);

	// A two-second note still surges at 600ms; even the longest hold ends at 960.
	await clock.tick(600);
	assert.ok(engine.view.pulse > 0, `pulse ${engine.view.pulse}`);
	await clock.tick(400);
	assert.equal(engine.view.pulse, 0);
});

test("a long note buys the whole line, not a count of tokens", async (t) => {
	const dir = scratch();
	// A whole note at 120 BPM: one strike outgrows the token scale altogether.
	const file = sequence(
		header(0, 1, PPQ),
		track(tempo(0, 500_000), noteOn(0, 60, VELOCITY), noteOff(4 * PPQ, 60), endOfTrack(8 * PPQ)),
	);
	const { engine, clock } = rig(t, { tracks: [midiTrack(dir, "Long", file)] });

	// A line the eight tokens of a beat could never cover.
	const line = "a line the tokens of a single beat could never cover\n";
	engine.feed(line);
	await clock.tick(0);
	assert.equal(engine.queue.printed, line);
});

test("a whole-line strike landing mid-line takes the rest of the line and the next", async (t) => {
	const dir = scratch();
	// Three-beat notes at full velocity: every strike buys a line.
	const file = sequence(
		header(0, 1, PPQ),
		track(
			tempo(0, 500_000),
			noteOn(0, 60, VELOCITY),
			noteOff(3 * PPQ, 60),
			noteOn(PPQ, 60, VELOCITY),
			noteOff(3 * PPQ, 60),
			endOfTrack(PPQ),
		),
	);
	const { engine, clock } = rig(t, { tracks: [midiTrack(dir, "Long", file)] });

	// The first strike opens a line the model has not finished.
	engine.feed("start of the line");
	await clock.tick(0);
	assert.equal(engine.queue.printed, "start of the line");

	// The second lands with the cursor mid-line: the rest of it and the next
	// line come out in one piece.
	engine.feed(" and the rest\nnext line\nthird line still queued");
	await clock.tick(2_000);
	assert.equal(engine.queue.printed, "start of the line and the rest\nnext line\n");
	assert.equal(engine.queue.backlog, "third line still queued".length);
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

	for (const chunk of chunks(20)) engine.feed(chunk, true);
	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(8).join(""));

	// The second strike, then the rest of the first track's length.
	await clock.tick(1_000);
	assert.deepEqual(titles, ["First", "Second"]);

	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(20).join(""));
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

	for (const chunk of chunks(20)) engine.feed(chunk, true);
	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(8).join(""));

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

test("a pause cuts the music, not the printing", async (t) => {
	const dir = scratch();
	const backend = honestBackend();
	const { engine, clock } = rig(t, { tracks: [midiTrack(dir, "First", twoOnsets(), true)], backend });

	for (const chunk of chunks(20)) engine.feed(chunk, true);
	await settle();
	await clock.tick(0);
	// Twenty tokens; the strike at zero prints eight of them and the rest waits.
	assert.equal(engine.queue.printed, chunks(8).join(""));
	assert.equal(engine.queue.backlog, 34);

	await clock.tick(250);
	const running = engine.view.elapsed;

	// A request parked on a deep backlog: only the printing can let it go.
	deepBacklog(engine);
	let released = false;
	const parked = engine.waitForCapacity().then(() => {
		released = true;
	});
	await settle();
	assert.equal(released, false);

	assert.equal(engine.pause(), true);
	assert.equal(engine.isPaused, true);
	assert.equal(engine.view.paused, true);
	assert.equal(backend.stops.count, 1);

	// The music is cut; the printing is not. With no beats to wait on the whole
	// backlog goes out at once, and the parked request is let go with it.
	assert.equal(engine.queue.isEmpty, true);
	await parked;
	assert.equal(released, true);

	// Text arriving while held prints on arrival, not on a beat.
	engine.feed("#tail", true);
	assert.ok(engine.queue.printed.endsWith("#tail"));
	assert.equal(engine.queue.isEmpty, true);

	// The clock stands where the pause left it, and the strike it would have
	// waited on never lands.
	await clock.tick(600);
	assert.equal(engine.view.elapsed, running);
	assert.ok(engine.queue.printed.endsWith("#tail"));
	assert.equal(engine.view.paused, true);
});

test("the resume takes the current track from its top, and the beats pace the print again", async (t) => {
	const dir = scratch();
	const backend = honestBackend();
	const { engine, clock } = rig(t, { tracks: [midiTrack(dir, "First", twoOnsets(), true)], backend });

	for (const chunk of chunks(20)) engine.feed(chunk, true);
	await settle();
	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(8).join(""));

	engine.pause();
	// The hold printed the tail out; nothing is left waiting.
	assert.equal(engine.queue.isEmpty, true);

	engine.resume();
	assert.equal(engine.isPaused, false);
	assert.equal(engine.view.paused, false);
	await settle();
	// The same track, opened again from its top.
	assert.equal(backend.played.length, 2);
	assert.equal(engine.view.elapsed, 0);

	// The beats are the pacer again: a token queued after the resume waits for
	// the next strike instead of going out on arrival.
	engine.feed("#live", true);
	assert.equal(engine.queue.backlog, 5);
	assert.equal(engine.queue.printed.endsWith("#live"), false);

	await clock.tick(500);
	assert.ok(engine.queue.printed.endsWith("#live"));
	assert.equal(engine.queue.isEmpty, true);
});

test("a pause prints a settled task's tail out, and that is the end of the performance", async (t) => {
	const dir = scratch();
	const backend = honestBackend();
	const { engine, handBacks, clock } = rig(t, { tracks: [midiTrack(dir, "First", twoOnsets(), true)], backend });

	for (const chunk of chunks(20)) engine.feed(chunk, true);
	await settle();
	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(8).join(""));

	// The task is over but its tail is still queued: the performance plays on.
	engine.onTaskSettled();
	assert.equal(engine.isPlaying, true);

	// The hold prints the tail out at once, and a settled queue that empties is
	// the end it would have been at the next strike — nothing left to hold.
	assert.equal(engine.pause(), false);
	assert.equal(engine.isPlaying, false);
	assert.equal(engine.queue.total, 0);
	assert.equal(engine.view.title, "");
	assert.equal(handBacks.count, 1);

	// The held track loop is gone with the performance, and the release has
	// nothing left to start: no second track is ever opened.
	assert.equal(engine.resume(), false);
	await clock.tick(2_000);
	assert.equal(backend.played.length, 1);
});

test("a pause holds the playlist too: the resumed task replays the same track", async (t) => {
	const dir = scratch();
	const { engine, titles, clock } = rig(t, {
		tracks: [midiTrack(dir, "First", twoOnsets()), midiTrack(dir, "Second", twoOnsets())],
	});

	for (const chunk of chunks(20)) engine.feed(chunk, true);
	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(8).join(""));
	assert.deepEqual(titles, ["First"]);

	engine.pause();
	// The hold printed the tail out, and no beat followed it. The wait runs long
	// enough that the track would have ended and the playlist moved on, had the
	// pause not stopped the loop where it stood.
	assert.equal(engine.queue.printed, chunks(20).join(""));
	await clock.tick(1_500);
	assert.deepEqual(titles, ["First"]);

	// Taken from the top, the same track gets its full length again before the
	// playlist may reach the next one.
	engine.resume();
	await settle();
	await clock.tick(999);
	assert.deepEqual(titles, ["First"]);
	await clock.tick(1);
	assert.deepEqual(titles, ["First", "Second"]);
});

test("a skip cuts the current track and takes the next one", async (t) => {
	const dir = scratch();
	const backend = honestBackend();
	const { engine, titles, clock } = rig(t, {
		tracks: [midiTrack(dir, "First", twoOnsets(), true), midiTrack(dir, "Second", twoOnsets(), true)],
		backend,
	});

	for (const chunk of chunks(16)) engine.feed(chunk, true);
	await settle();
	await clock.tick(0);
	assert.equal(engine.view.title, "First");
	assert.equal(backend.played.length, 1);

	// The player is cut and the next track opens at once, from its top; the
	// queue's tail is not cut with the music.
	assert.equal(engine.skip(), true);
	await settle();
	assert.equal(backend.stops.count, 1);
	assert.equal(backend.played.length, 2);
	assert.deepEqual(titles, ["First", "Second"]);
	assert.equal(engine.view.title, "Second");
	assert.equal(engine.view.elapsed, 0);
	assert.equal(engine.queue.printed, chunks(8).join(""));

	// The new track's beats pace the tail from here.
	await clock.tick(0);
	assert.equal(engine.queue.printed, chunks(16).join(""));
});

test("a skip pressed under the hold opens the next track on the resume", async (t) => {
	const dir = scratch();
	const backend = honestBackend();
	const { engine, titles, clock } = rig(t, {
		tracks: [midiTrack(dir, "First", twoOnsets(), true), midiTrack(dir, "Second", twoOnsets(), true)],
		backend,
	});

	for (const chunk of chunks(10)) engine.feed(chunk, true);
	await settle();
	await clock.tick(0);
	assert.equal(engine.view.title, "First");

	engine.pause();
	await settle();
	assert.equal(engine.isPaused, true);

	// The press is remembered: the hold stands and the stage still names the
	// held track, but the resume no longer opens it again.
	assert.equal(engine.skip(), true);
	await settle();
	assert.equal(engine.isPaused, true);
	assert.equal(engine.view.title, "First");
	assert.equal(backend.played.length, 1);

	engine.resume();
	await settle();
	assert.equal(backend.played.length, 2);
	assert.equal(engine.view.title, "Second");
	assert.deepEqual(titles, ["First", "Second"]);
});

test("a skip with nothing playing is a no-op", async (t) => {
	const dir = scratch();
	const backend = honestBackend();
	const { engine } = rig(t, { tracks: [midiTrack(dir, "First", oneOnset(), true)], backend });

	assert.equal(engine.skip(), false);
	assert.equal(backend.stops.count, 0);
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

	// Two sixteenths print six tokens: still nowhere near caught up.
	await clock.tick(125);
	assert.ok(engine.queue.backlog > 600, `backlog ${engine.queue.backlog}`);
	assert.equal(released, false);

	// Each strike pays three tokens off the backlog; once the printing has caught
	// up, the model is let go.
	await clock.tick(5_500);
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
	assert.deepEqual(errors, ["real-vibe-coding: no player here"]);
	assert.equal(engine.isPlaying, false);
	assert.equal(backend.stops.count, 1);
});

test("an engine with no tracks says so once", async (t) => {
	const { engine, errors } = rig(t, { tracks: [] });

	engine.feed("ab", true);
	await settle();
	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /library is empty/);
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
