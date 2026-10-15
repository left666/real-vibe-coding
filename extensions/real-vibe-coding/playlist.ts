/**
 * Which track plays next. Pure: the die is injected, so shuffle is
 * reproducible in tests.
 */

export type PlaylistMode = "sequential" | "shuffle" | "loop-one";

export const PLAYLIST_MODES: readonly PlaylistMode[] = ["sequential", "shuffle", "loop-one"];

export class Playlist<T> {
	private at = -1;
	private started = false;
	private readonly tracks: readonly T[];
	private readonly mode: PlaylistMode;
	private readonly die: () => number;

	constructor(tracks: readonly T[], mode: PlaylistMode, die: () => number = Math.random) {
		this.tracks = tracks;
		this.mode = mode;
		this.die = die;
	}

	get size(): number {
		return this.tracks.length;
	}

	/** The track to play now, or undefined only when the playlist is empty. */
	next(): T | undefined {
		const size = this.tracks.length;
		if (size === 0) return undefined;
		// One track is the same track under every mode, one-track loop included.
		if (size === 1) {
			this.at = 0;
			this.started = true;
			return this.tracks[0];
		}

		if (!this.started) {
			this.started = true;
			this.at = this.mode === "shuffle" ? this.roll(size) : 0;
			return this.tracks[this.at];
		}

		if (this.mode === "sequential") {
			this.at = (this.at + 1) % size;
		} else if (this.mode === "shuffle") {
			// Anywhere but the track that just played, so no track repeats back to back.
			this.at = (this.at + 1 + this.roll(size - 1)) % size;
		}
		// "loop-one" leaves the cursor where it is.

		return this.tracks[this.at];
	}

	private roll(span: number): number {
		const value = Math.min(0.999999, Math.max(0, this.die()));
		return Math.floor(value * span);
	}
}
