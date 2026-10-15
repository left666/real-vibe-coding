import assert from "node:assert/strict";
import { test } from "node:test";

import { Playlist } from "../extensions/real-vibe-coding/playlist.ts";

/** A die that walks a fixed list, so a shuffle is reproducible. */
function dieFrom(values: readonly number[]): () => number {
	let at = 0;
	return () => values[at++ % values.length]!;
}

test("an empty playlist has nothing to play", () => {
	for (const mode of ["sequential", "shuffle", "loop-one"] as const) {
		const playlist = new Playlist([], mode);
		assert.equal(playlist.next(), undefined);
		assert.equal(playlist.next(), undefined);
		assert.equal(playlist.size, 0);
	}
});

test("one track is the same track under every mode", () => {
	for (const mode of ["sequential", "shuffle", "loop-one"] as const) {
		let rolls = 0;
		const playlist = new Playlist(["only"], mode, () => {
			rolls += 1;
			return 0;
		});

		assert.equal(playlist.next(), "only");
		assert.equal(playlist.next(), "only");
		assert.equal(playlist.next(), "only");
		assert.equal(rolls, 0);
	}
});

test("sequential walks the list and starts over", () => {
	const playlist = new Playlist(["a", "b", "c"], "sequential");

	assert.deepEqual(
		[playlist.next(), playlist.next(), playlist.next(), playlist.next(), playlist.next()],
		["a", "b", "c", "a", "b"],
	);
});

test("loop-one plays the first track and stays on it", () => {
	const playlist = new Playlist(["a", "b"], "loop-one");

	assert.equal(playlist.next(), "a");
	assert.equal(playlist.next(), "a");
	assert.equal(playlist.next(), "a");
});

test("shuffle takes its first track from the die", () => {
	const playlist = new Playlist(["a", "b", "c", "d"], "shuffle", dieFrom([0.9]));
	assert.equal(playlist.next(), "d");

	const zero = new Playlist(["a", "b", "c", "d"], "shuffle", dieFrom([0]));
	assert.equal(zero.next(), "a");
});

test("shuffle never plays a track twice in a row", () => {
	// Values chosen so the short hop would be backwards on some steps and forwards on others.
	const playlist = new Playlist(["a", "b", "c", "d", "e"], "shuffle", dieFrom([0, 0.999, 0.5, 0.25, 0.75, 0.1]));

	let previous = playlist.next();
	for (let step = 0; step < 200; step++) {
		const track = playlist.next();
		assert.notEqual(track, previous);
		assert.ok(track !== undefined);
		previous = track;
	}
});

test("shuffle can reach every track", () => {
	const playlist = new Playlist(["a", "b", "c"], "shuffle", dieFrom([0.5, 0.3, 0.8, 0.6, 0.1]));
	const seen = new Set<string>();
	for (let step = 0; step < 60; step++) {
		const track = playlist.next();
		if (track !== undefined) seen.add(track);
	}
	assert.deepEqual([...seen].sort(), ["a", "b", "c"]);
});

test("a die that sticks to its bounds still picks inside the playlist", () => {
	for (const value of [-1, 0, 0.5, 1, 2]) {
		const playlist = new Playlist(["a", "b", "c"], "shuffle", dieFrom([value]));
		for (let step = 0; step < 20; step++) {
			assert.ok(["a", "b", "c"].includes(playlist.next() as string));
		}
	}
});
