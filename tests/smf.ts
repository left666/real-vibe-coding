/** Builds Standard MIDI Files byte by byte, so the reader is fed exact input. */

export function vlq(value: number): number[] {
	const bytes = [value & 0x7f];
	let rest = value >>> 7;
	while (rest > 0) {
		bytes.unshift((rest & 0x7f) | 0x80);
		rest >>>= 7;
	}
	return bytes;
}

export function u16(value: number): number[] {
	return [(value >>> 8) & 0xff, value & 0xff];
}

export function u24(value: number): number[] {
	return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function u32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function chunk(id: string, data: readonly number[]): number[] {
	return [...[...id].map((character) => character.charCodeAt(0)), ...u32(data.length), ...data];
}

export function header(format: number, trackCount: number, division: number, extra: readonly number[] = []): number[] {
	return chunk("MThd", [...u16(format), ...u16(trackCount), ...u16(division), ...extra]);
}

export function track(...events: readonly number[][]): number[] {
	return chunk("MTrk", events.flat());
}

export function noteOn(delta: number, note: number, velocity: number, channel = 0): number[] {
	return [...vlq(delta), 0x90 | channel, note & 0x7f, velocity & 0x7f];
}

export function noteOff(delta: number, note: number, channel = 0): number[] {
	return [...vlq(delta), 0x80 | channel, note & 0x7f, 0x40];
}

/** A meta event whose payload is a raw byte list. */
export function meta(delta: number, type: number, payload: readonly number[]): number[] {
	return [...vlq(delta), 0xff, type, ...vlq(payload.length), ...payload];
}

export function tempo(delta: number, usPerQuarter: number): number[] {
	return meta(delta, 0x51, u24(usPerQuarter));
}

export function endOfTrack(delta = 0): number[] {
	return meta(delta, 0x2f, []);
}

export function sysex(delta: number, payload: readonly number[]): number[] {
	return [...vlq(delta), 0xf0, ...vlq(payload.length), ...payload];
}

export function sequence(...parts: readonly number[][]): Uint8Array {
	return Uint8Array.from(parts.flat());
}
