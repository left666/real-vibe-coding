/**
 * The beat engine: takes text into the print queue and reveals it on the onsets
 * of a MIDI timeline while the matching audio plays.
 *
 * Two clocks, deliberately apart. The onset chain is re-armed from the absolute
 * target time after every hit, so a stalled frame cannot shift the beats that
 * follow it. The animation timer only drives the visual pulse and the clock
 * readout — dropping frames never moves a beat.
 *
 * A performance ends on `settled && queue.isEmpty`: the task must be over *and*
 * everything queued must have been printed. That stop is `finish()` — the stage
 * comes down and the text is handed to the transcript, the only place a whole
 * task's output fits.
 *
 * A pause is the one stop that is not an end: the player is cut, the beats are
 * cancelled and the clock freezes where it stood. The printing is not held with
 * it — with no beats to wait on, the queue lets everything out at once and text
 * fed while held prints as it arrives, which is Pi's own pace. A resume takes
 * the current track from its top — the audio cannot be picked up mid-file — and
 * the music paces whatever the printing does from then on.
 *
 * The engine also holds the model back: while far more text is queued than the
 * music can print, `waitForCapacity` keeps the next request waiting, so a long
 * task cannot stuff the queue faster than it drains.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { AudioBackend } from "./audio.ts";
import type { Track } from "./library.ts";
import { trackTitle } from "./library.ts";
import { readTimeline } from "./midi.ts";
import type { Onset, Timeline } from "./midi.ts";
import { Playlist } from "./playlist.ts";
import type { PlaylistMode } from "./playlist.ts";
import { PrintQueue, burst } from "./queue.ts";

/** Everything the stage needs to draw one frame. Declared here so the engine keeps out of the TUI's way. */
export interface StageView {
	/** Track name — the file's stem — or "" before the first track of a task starts. */
	title: string;
	bpm: number;
	/** Seconds into the current track. */
	elapsed: number;
	/** Seconds of the current track. */
	duration: number;
	mode: PlaylistMode;
	/** Velocity of the latest onset, 0..1. 0 before the first one and once the music stops. */
	energy: number;
	/** 1 on an onset, decaying towards 0 before the next one. */
	pulse: number;
	/** The performance is held: the clock stands still and the music is cut. */
	paused: boolean;
}

function idleView(): StageView {
	return { title: "", bpm: 0, elapsed: 0, duration: 0, mode: "sequential", energy: 0, pulse: 0, paused: false };
}

/** Thirty frames a second: enough for a ripple, cheap enough to leave the beat alone. */
const FRAME_MS = 33;
/** A strike's surge is gone this long after it lands. */
const PULSE_DECAY_MS = 240;

/**
 * Backlog tolerated before the next request to the model is held back — around
 * a minute of printing at the pace the music sets — and the level it has to
 * fall back to before that request is let go. The gap is what the printing must
 * recover for the model to be allowed another turn.
 */
const HOLD_BACKLOG_CHARS = 2400;
const RELEASE_BACKLOG_CHARS = 600;

export interface EngineSettings {
	tracks: readonly Track[];
	mode: PlaylistMode;
	/** The title loop-one repeats; "" is the library's first track. */
	loopTrack: string;
	/** Absorbs the player's process-start latency, so the print tracks the sound. */
	musicSyncOffsetMs: number;
	backend: AudioBackend;
}

export interface BeatEngineOptions extends EngineSettings {
	/** The stage should redraw. */
	onView: () => void;
	onError: (message: string) => void;
	/** The task is over, the queue is empty: the transcript can have its text back. */
	onHandBack: () => void;
	/** Monotonic milliseconds; injected by tests. */
	now?: () => number;
}

interface SilentWait {
	timer: NodeJS.Timeout;
	resolve: () => void;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class BeatEngine {
	readonly queue = new PrintQueue();
	readonly view: StageView = idleView();

	private settings: EngineSettings;
	private readonly onView: () => void;
	private readonly onError: (message: string) => void;
	private readonly onHandBack: () => void;
	private readonly now: () => number;

	private enabled = true;
	private playing = false;
	private settled = false;
	/** The performance is held where it stands; the track loop waits for `resume`. */
	private paused = false;
	private warnedMissingTracks = false;
	/** Requests parked in `waitForCapacity`, to be let go once the printing catches up. */
	private parked: (() => void)[] = [];
	/** The track loop's wait through a pause, let go by `resume` — or by `stop`, which ends the run. */
	private held: (() => void)[] = [];

	/**
	 * The session's place in the library. One playlist per engine: a finished task
	 * leaves it where it stopped, so the next task of the same session takes the
	 * next track instead of starting the library over.
	 */
	private playlist: Playlist<Track> | null = null;

	/** Identifies the run the timers and the track loop belong to. */
	private run = 0;
	/** When the current track's clock reads zero. */
	private openedAt = 0;
	private struckAt = 0;
	private onsetTimer: NodeJS.Timeout | null = null;
	private frameTimer: NodeJS.Timeout | null = null;
	private silentWait: SilentWait | null = null;

	constructor(options: BeatEngineOptions) {
		this.settings = options;
		this.onView = options.onView;
		this.onError = options.onError;
		this.onHandBack = options.onHandBack;
		this.now = options.now ?? (() => performance.now());
	}

	get isPlaying(): boolean {
		return this.playing;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	configure(settings: EngineSettings): void {
		// A change of order starts the walk over; the other settings leave the place
		// alone, so switching the backend mid-session does not lose it.
		const restart =
			settings.tracks !== this.settings.tracks ||
			settings.mode !== this.settings.mode ||
			settings.loopTrack !== this.settings.loopTrack;
		this.settings = settings;
		if (restart) this.playlist = null;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.queue.reset();
			this.stop();
		}
	}

	/**
	 * Producer side: text ready to print. Starts the music on the first call of a
	 * task. `whole` marks a chunk the reveal may not cut through — a provider
	 * delta, one token. Returns whether the text was taken: a switched-off engine
	 * takes nothing, and the caller needs to know, because it is the caller that
	 * records where in the queue the text went.
	 */
	feed(text: string, whole = false): boolean {
		if (!this.enabled || text.length === 0) return false;
		this.queue.push(text, whole);

		if (!this.playing) {
			this.playing = true;
			this.run += 1;
			this.frameTimer = setInterval(() => this.frame(), FRAME_MS);
			void this.playTracks(this.run);
		}
		// A held performance prints as its text arrives: with the beats gone the
		// queue has nothing to wait on, so it never stands between the stream and
		// the reader.
		if (this.paused) this.printWhilePaused();
		return true;
	}

	/**
	 * Backpressure for the model rather than for the queue: resolves at once
	 * unless the printing is far behind, and otherwise waits for it to catch up.
	 * Waiting is only safe because printing is under way — an engine that stops,
	 * or is switched off, lets every waiter go, so nothing can wait forever.
	 */
	async waitForCapacity(): Promise<void> {
		if (!this.playing || this.queue.backlog <= HOLD_BACKLOG_CHARS) return;
		await new Promise<void>((resolve) => this.parked.push(resolve));
	}

	onTaskStart(): void {
		this.settled = false;
	}

	/** The task is over. The performance ends once the queue has drained too. */
	onTaskSettled(): void {
		this.settled = true;
		if (this.queue.isEmpty) this.finish();
	}

	/**
	 * Print everything still queued, cut the music, and end the performance here:
	 * the reader asked for the rest of the task now, so the stage comes down and
	 * the text goes to the transcript, the only place all of it fits.
	 */
	flush(): void {
		this.queue.drain();
		this.finish();
	}

	/**
	 * Hold the performance where it stands: the beats are cut, the music stops
	 * and the clock freezes. The printing is not held with it — with no beats to
	 * wait on, everything queued goes out at once, and text that arrives while
	 * held prints as it comes. Returns whether a performance is still held when
	 * the dust settles: a settled queue that empties here is an end, not a hold.
	 */
	pause(): boolean {
		if (!this.playing || this.paused) return false;
		this.paused = true;
		this.view.paused = true;
		this.cancelOnset();
		this.endSilentWait();
		this.settings.backend.stop();
		this.view.energy = 0;
		this.view.pulse = 0;
		this.printWhilePaused();
		return this.playing;
	}

	/**
	 * Let the held performance go on. The track loop was waiting on the pause and
	 * takes the current track from its top — the audio cannot be picked up
	 * mid-file. The printing never waited: the music paces what comes in from
	 * here, whatever the hold already printed.
	 */
	resume(): boolean {
		if (!this.paused) return false;
		this.paused = false;
		this.view.paused = false;
		this.releaseHeld();
		this.onView();
		return true;
	}

	reset(): void {
		this.queue.reset();
		this.stop();
		this.settled = false;
		this.warnedMissingTracks = false;
		Object.assign(this.view, idleView());
		this.onView();
	}

	stop(): void {
		this.playing = false;
		this.paused = false;
		this.run += 1;
		// Whatever still waits on the printing — or on a resume — is not going to
		// get it.
		this.wake();
		this.releaseHeld();
		this.cancelOnset();
		this.endSilentWait();
		if (this.frameTimer) {
			clearInterval(this.frameTimer);
			this.frameTimer = null;
		}
		this.settings.backend.stop();
		// The ripple is driven by the beat: with the music gone it has nothing left to move it.
		this.view.energy = 0;
		this.view.pulse = 0;
		this.view.paused = false;
		this.onView();
	}

	/**
	 * The task is over and the last line is out. The hand-back is what takes the
	 * stage down — a fixed-height window could only scroll a task's output past
	 * the reader — and lets the transcript show all of it.
	 */
	private finish(): void {
		this.queue.reset();
		Object.assign(this.view, idleView());
		this.stop();
		this.onHandBack();
	}

	/** Let parked requests go once the printing has caught up. */
	private wake(): void {
		if (this.parked.length === 0) return;
		if (this.playing && this.queue.backlog > RELEASE_BACKLOG_CHARS) return;
		const parked = this.parked;
		this.parked = [];
		for (const resolve of parked) resolve();
	}

	/**
	 * The print of a held performance: with the beats gone the queue has nothing
	 * to wait on, so everything in it goes out now — and text fed while held
	 * prints the same way, at the pace it arrives. An empty queue with the task
	 * over is an end like any other: there was nothing left to hold.
	 */
	private printWhilePaused(): void {
		this.queue.drain();
		this.wake();
		if (this.settled && this.queue.isEmpty) {
			this.finish();
			return;
		}
		this.onView();
	}

	/** Let the track loop go on from its pause. */
	private releaseHeld(): void {
		if (this.held.length === 0) return;
		const held = this.held;
		this.held = [];
		for (const resolve of held) resolve();
	}

	/** The track loop's stand-through-a-pause: resolved by `resume`, or by `stop`. */
	private waitResume(): Promise<void> {
		if (!this.paused) return Promise.resolve();
		return new Promise<void>((resolve) => this.held.push(resolve));
	}

	/**
	 * The tracks the session's playlist walks. Loop-one walks just the chosen
	 * track — a one-track list repeats it under any mode — while no choice, or a
	 * choice the library does not have, means the whole library, whose first
	 * track loop-one then repeats.
	 */
	private playlistSource(): readonly Track[] {
		const chosen = this.settings.loopTrack;
		if (this.settings.mode !== "loop-one" || chosen === "") return this.settings.tracks;
		const picked = this.settings.tracks.filter((track) => trackTitle(track.midi).toLowerCase() === chosen.toLowerCase());
		return picked.length > 0 ? picked : this.settings.tracks;
	}

	private async playTracks(run: number): Promise<void> {
		const playlist = (this.playlist ??= new Playlist(this.playlistSource(), this.settings.mode));

		while (this.playing && run === this.run) {
			const track = playlist.next();
			if (!track) {
				if (!this.warnedMissingTracks) {
					this.warnedMissingTracks = true;
					this.onError("code-dance: the library is empty — put paired .mid/.wav files in <agent dir>/code-dance/music");
				}
				this.stop();
				return;
			}

			let timeline: Timeline;
			try {
				timeline = readTimeline(readFileSync(track.midi));
			} catch (error) {
				this.onError(`code-dance: ${basename(track.midi)}: ${describe(error)}`);
				this.stop();
				return;
			}

			if (!(await this.performTrack(track, timeline, run))) return;
		}
	}

	/**
	 * One track from its first beat to its end. A pause cuts its player mid-file,
	 * so the loop waits the pause out here and then takes the same track from the
	 * top. Returns whether the playlist may move on; false means the run is over.
	 */
	private async performTrack(track: Track, timeline: Timeline, run: number): Promise<boolean> {
		while (this.playing && run === this.run) {
			this.openTrack(track, timeline);
			this.armOnset(timeline.onsets, 0, run);

			try {
				// A track with no recording still keeps time: the MIDI is the clock,
				// the audio is only what you hear.
				await (track.audio ? this.settings.backend.play(track.audio) : this.waitSilently(timeline.duration * 1000));
			} catch (error) {
				this.onError(`code-dance: ${describe(error)}`);
				this.stop();
				return false;
			}

			if (!this.playing || run !== this.run) return false;
			this.cancelOnset();
			if (this.settled && this.queue.isEmpty) {
				this.finish();
				return false;
			}
			if (this.paused) {
				await this.waitResume();
				continue;
			}
			// Text is still queued, or the model is still working: next track.
			return true;
		}
		return false;
	}

	private openTrack(track: Track, timeline: Timeline): void {
		this.view.title = trackTitle(track.midi);
		this.view.bpm = timeline.bpm;
		this.view.duration = timeline.duration;
		this.view.mode = this.settings.mode;
		this.view.elapsed = 0;
		this.view.energy = 0;
		this.view.pulse = 0;
		this.struckAt = 0;
		this.openedAt = this.now() + this.settings.musicSyncOffsetMs;
		this.onView();
	}

	/**
	 * Arm one onset, and arm the next from inside its callback. Re-reading the
	 * clock each time is what keeps one late frame from shifting every beat after
	 * it.
	 */
	private armOnset(onsets: readonly Onset[], index: number, run: number): void {
		if (!this.playing || run !== this.run) return;
		const onset = onsets[index];
		if (!onset) return;

		const wait = Math.max(0, this.openedAt + onset.seconds * 1000 - this.now());
		this.onsetTimer = setTimeout(() => {
			this.onsetTimer = null;
			if (!this.playing || run !== this.run) return;
			this.strike(onset.velocity);
			this.armOnset(onsets, index + 1, run);
		}, wait);
	}

	private strike(velocity: number): void {
		this.queue.reveal(burst(velocity, this.view.bpm));
		this.view.energy = velocity;
		this.struckAt = this.now();
		this.view.pulse = 1;
		this.wake();
		this.onView();

		if (this.settled && this.queue.isEmpty) this.finish();
	}

	private frame(): void {
		// A held performance has no clock of its own: the readout stands at the
		// moment it was paused until the resumed track opens again. The view still
		// gets its call — the printing may have moved, and a throttled transcript
		// repaint needs a later frame to come due on.
		if (this.paused) {
			this.onView();
			return;
		}
		const now = this.now();
		this.view.pulse = Math.max(0, 1 - (now - this.struckAt) / PULSE_DECAY_MS);
		this.view.elapsed = Math.min(this.view.duration, Math.max(0, (now - this.openedAt) / 1000));
		this.onView();
	}

	private cancelOnset(): void {
		if (!this.onsetTimer) return;
		clearTimeout(this.onsetTimer);
		this.onsetTimer = null;
	}

	/** A track with no `.wav`: hold for its length so the next one still follows on time. */
	private waitSilently(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.silentWait = null;
				resolve();
			}, Math.max(0, ms));
			this.silentWait = { timer, resolve };
		});
	}

	private endSilentWait(): void {
		const wait = this.silentWait;
		if (!wait) return;
		this.silentWait = null;
		clearTimeout(wait.timer);
		wait.resolve();
	}
}
