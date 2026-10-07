/**
 * Minimal Standard MIDI File reader.
 *
 * CodeDance wants exactly five things from a `.mid`: when a note starts, how
 * hard it was struck, how high it sits, how long it is held and how many notes
 * strike with it. The first is the print rhythm; the accent scales the budget
 * of a single onset, the length is the time it buys and the chord the weight it
 * carries; the pitch sets how fine the stage's ripple runs, and the length how
 * long the strike's surge holds. Everything else the file carries —
 * controllers, pitch bend, program changes, lyrics — is stepped over.
 *
 * The tempo map is followed, not averaged: a track that accelerates mid-way is
 * printed at the speed it actually plays. `format 1` files (one track per
 * instrument) merge into a single onset list, because the printer only cares
 * about the union of all notes.
 */

/** After tempo math, a chord's notes land a few milliseconds apart. Fold them into one onset. */
const CHORD_WINDOW_SECONDS = 0.03;

/** The tempo the SMF spec assumes when a file never sets one: 120 BPM. */
const DEFAULT_US_PER_QUARTER = 500_000;

export interface Onset {
	/** Seconds from the start of the track. */
	seconds: number;
	/** MIDI velocity, 0..1. */
	velocity: number;
	/** MIDI note number, 0..1: the lowest key is 0, the highest 1. */
	pitch: number;
	/** Seconds from the strike to its release, tempo changes and all; 0 when the file has no length to give. */
	duration: number;
	/** How many notes of the file sound as this one strike: a single note 1, a chord its size. */
	thickness: number;
}

export interface Timeline {
	/** Tempo at the start of the track, for the readout and the burst budget. */
	bpm: number;
	/** Seconds to the last event in the file — where its rhythm ends. */
	duration: number;
	/** Sorted by time, chords merged. */
	onsets: readonly Onset[];
}

interface TempoPoint {
	tick: number;
	usPerQuarter: number;
}

interface Attack {
	tick: number;
	velocity: number;
	/** MIDI note number, 0..127. */
	note: number;
	/** Ticks from the strike to its release; 0 when the file has none to give. */
	heldTicks: number;
}

interface RawFile {
	/** Ticks per quarter note. */
	ppq: number;
	tempos: TempoPoint[];
	attacks: Attack[];
	/** Last tick any event in the file is scheduled at. */
	endTick: number;
}

class Reader {
	private readonly bytes: Uint8Array;
	private at = 0;
	/** Reads stop here: the end of the chunk being read, the end of the file otherwise. */
	private limit: number;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.limit = bytes.length;
	}

	get offset(): number {
		return this.at;
	}

	set offset(value: number) {
		this.at = value;
	}

	get remaining(): number {
		return this.limit - this.at;
	}

	/** Bound reads to the chunk whose payload starts here. */
	enterChunk(length: number): void {
		this.limit = this.at + length;
	}

	leaveChunk(): void {
		this.limit = this.bytes.length;
	}

	u8(): number {
		if (this.at >= this.limit) throw new Error("SMF: event runs past the end of its chunk");
		if (this.at >= this.bytes.length) throw new Error("SMF: file ends mid-event");
		return this.bytes[this.at++]!;
	}

	u16(): number {
		return (this.u8() << 8) | this.u8();
	}

	u32(): number {
		return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
	}

	tag(): string {
		return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8());
	}

	/** Variable-length quantity: seven bits per byte, high bit means "more". */
	vlq(): number {
		let value = 0;
		for (let read = 0; read < 4; read++) {
			const byte = this.u8();
			value = (value << 7) | (byte & 0x7f);
			if ((byte & 0x80) === 0) return value;
		}
		throw new Error("SMF: variable-length quantity is longer than four bytes");
	}

	skip(count: number): void {
		if (count > this.remaining) throw new Error("SMF: event runs past the end of its chunk");
		this.at += count;
	}
}

/** Read one chunk's payload: `length` bytes from the current offset. */
function readTrack(reader: Reader, length: number, out: RawFile): void {
	const end = reader.offset + length;
	reader.enterChunk(length);
	let tick = 0;
	let runningStatus = 0;
	/** The strikes still sounding, by channel and note: each waits here for the release that clocks it. */
	const sounding = new Map<number, Attack>();

	while (reader.offset < end) {
		tick += reader.vlq();

		let status = reader.u8();
		if (status < 0x80) {
			// Running status: the byte we just read is data, the status is the previous one.
			if (runningStatus === 0) throw new Error("SMF: data byte before any status byte");
			reader.offset -= 1;
			status = runningStatus;
		} else if (status < 0xf0) {
			runningStatus = status;
		}

		if (status === 0xff) {
			const metaType = reader.u8();
			const length = reader.vlq();
			if (metaType === 0x51 && length === 3) {
				const usPerQuarter = (reader.u8() << 16) | (reader.u8() << 8) | reader.u8();
				out.tempos.push({ tick, usPerQuarter });
			} else {
				reader.skip(length);
			}
			// A meta event cancels running status for the next event.
			runningStatus = 0;
		} else if (status === 0xf0 || status === 0xf7) {
			reader.skip(reader.vlq());
			runningStatus = 0;
		} else {
			const high = status & 0xf0;
			const data1 = reader.u8();
			// Program change and channel pressure carry one data byte; the rest carry two.
			const data2 = high === 0xc0 || high === 0xd0 ? 0 : reader.u8();
			const key = ((status & 0x0f) << 7) | data1;
			if (high === 0x90 && data2 > 0) {
				// A note struck again while it sounds closes the one before it here.
				const previous = sounding.get(key);
				if (previous) previous.heldTicks = tick - previous.tick;
				const attack: Attack = { tick, velocity: data2, note: data1, heldTicks: 0 };
				sounding.set(key, attack);
				out.attacks.push(attack);
			} else if (high === 0x80 || high === 0x90) {
				// A note-off, or the conventional stand-in: a note-on with velocity 0.
				const attack = sounding.get(key);
				if (attack) {
					attack.heldTicks = tick - attack.tick;
					sounding.delete(key);
				}
			}
		}

		if (tick > out.endTick) out.endTick = tick;
	}
}

function parseFile(bytes: Uint8Array): RawFile {
	const reader = new Reader(bytes);

	if (reader.tag() !== "MThd") throw new Error("SMF: missing MThd header (not a MIDI file)");
	const headerLength = reader.u32();
	if (headerLength < 6) throw new Error("SMF: header chunk is too short");
	reader.u16(); // format: 0 (one track), 1 (parallel tracks) and 2 (patterns) parse the same here
	const trackCount = reader.u16();
	const division = reader.u16();
	if (division & 0x8000) throw new Error("SMF: SMPTE time division is not supported");
	if (division === 0) throw new Error("SMF: header declares zero ticks per quarter note");
	reader.skip(headerLength - 6);

	const file: RawFile = { ppq: division, tempos: [], attacks: [], endTick: 0 };
	for (let track = 1; track <= trackCount; track++) {
		if (reader.remaining < 8) throw new Error(`SMF: track ${track} of ${trackCount} is missing`);
		if (reader.tag() !== "MTrk") throw new Error(`SMF: track ${track} of ${trackCount} is not an MTrk chunk`);
		const length = reader.u32();
		if (length > reader.remaining) throw new Error(`SMF: track ${track} of ${trackCount} runs past the end of the file`);
		readTrack(reader, length, file);
		reader.leaveChunk();
	}

	file.tempos.sort((a, b) => a.tick - b.tick);
	file.attacks.sort((a, b) => a.tick - b.tick);
	return file;
}

interface TempoMap {
	secondsAt(tick: number): number;
	readonly openingUsPerQuarter: number;
}

/**
 * Tick -> seconds under the file's own tempo changes. The segments are built
 * once so the conversion is a lookup instead of a walk per note.
 */
function tempoMap(ppq: number, tempos: readonly TempoPoint[]): TempoMap {
	const points: TempoPoint[] =
		tempos.length === 0 || tempos[0]!.tick > 0
			? [{ tick: 0, usPerQuarter: DEFAULT_US_PER_QUARTER }, ...tempos]
			: [...tempos];

	// Seconds elapsed when each segment starts.
	const starts: number[] = [];
	let elapsed = 0;
	for (let index = 0; index < points.length; index++) {
		const point = points[index]!;
		const previous = points[index - 1];
		if (previous) {
			elapsed += ((point.tick - previous.tick) * previous.usPerQuarter) / 1e6 / ppq;
		}
		starts.push(elapsed);
	}

	return {
		openingUsPerQuarter: points[0]!.usPerQuarter,
		secondsAt(tick: number): number {
			// Last segment whose own start is at or before the tick.
			let low = 0;
			let high = points.length - 1;
			while (low < high) {
				const middle = (low + high + 1) >> 1;
				if (points[middle]!.tick <= tick) low = middle;
				else high = middle - 1;
			}
			const point = points[low]!;
			return starts[low]! + ((tick - point.tick) * point.usPerQuarter) / 1e6 / ppq;
		},
	};
}

/**
 * Fold the notes of a chord into one onset: the hardest strike is the one it
 * describes — accent, pitch and length — and the count of notes it folded is
 * the thickness.
 */
function mergeChords(attacks: readonly Onset[]): Onset[] {
	const merged: Onset[] = [];
	for (const attack of attacks) {
		const last = merged[merged.length - 1];
		if (last && attack.seconds - last.seconds < CHORD_WINDOW_SECONDS) {
			last.thickness += 1;
			if (attack.velocity > last.velocity) {
				last.velocity = attack.velocity;
				last.pitch = attack.pitch;
				last.duration = attack.duration;
			}
			continue;
		}
		merged.push({ ...attack });
	}
	return merged;
}

/** Read a `.mid` into the timeline the beat engine plays against. Throws on malformed input. */
export function readTimeline(bytes: Uint8Array): Timeline {
	const file = parseFile(bytes);
	const map = tempoMap(file.ppq, file.tempos);

	const attacks = file.attacks
		.map((attack) => {
			const seconds = map.secondsAt(attack.tick);
			return {
				seconds,
				velocity: attack.velocity / 127,
				pitch: attack.note / 127,
				// The release rides the tempo map too: a note held across a change is
				// half the old beat, half the new. A release the file never writes
				// leaves the length 0 — there is none to be had.
				duration: attack.heldTicks > 0 ? map.secondsAt(attack.tick + attack.heldTicks) - seconds : 0,
				// Deeper counts come from `mergeChords`, which folds the chord's notes.
				thickness: 1,
			};
		})
		.sort((a, b) => a.seconds - b.seconds);

	return {
		bpm: 60_000_000 / map.openingUsPerQuarter,
		duration: map.secondsAt(file.endTick),
		onsets: mergeChords(attacks),
	};
}
