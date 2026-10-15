/**
 * What the transcript prints, in the units Pi's renderer uses: one text block,
 * one run of consecutive reasoning blocks, and the line for a tool call.
 *
 * The rewrite of the transcript and the feed to the stage have to agree on
 * exactly what these units are. `performedParts` is that agreement written
 * down once — the transformer's answer for a finalized message is keyed on the
 * hash of a unit taken from here, and `OutputFeed` replays the same trim and
 * join rules on the deltas, since the finished message does not exist yet
 * while it streams.
 */

import { createHash } from "node:crypto";

export interface PerformedPart {
	/** `text` is assistant prose; `thinking` is one run of consecutive reasoning blocks. */
	kind: "text" | "thinking";
	text: string;
}

/** Stable identity for a part's text: what the transformer is later asked about. */
export function partKey(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function countLines(text: string): number {
	return text === "" ? 0 : text.split("\n").length;
}

/**
 * The parts of a message Pi prints, in document order. Tool calls are absent:
 * they are not text, and Pi renders the line for one from the call itself.
 *
 * A run of reasoning blocks is a single unit because that is how Pi renders
 * it — blocks joined with a blank line, the whole run through the transformer
 * at once. Text blocks are one unit each. A part that is empty once trimmed is
 * dropped: Pi renders nothing for it.
 */
export function performedParts(content: unknown): PerformedPart[] {
	if (!Array.isArray(content)) return [];

	const parts: PerformedPart[] = [];
	let run: string[] = [];
	const endRun = (): void => {
		if (run.length > 0) parts.push({ kind: "thinking", text: run.join("\n\n") });
		run = [];
	};

	for (const raw of content) {
		const block = (raw ?? {}) as { type?: unknown; text?: unknown; thinking?: unknown };
		if (block.type === "text" && typeof block.text === "string") {
			endRun();
			const text = block.text.trim();
			if (text !== "") parts.push({ kind: "text", text });
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			const text = block.thinking.trim();
			if (text !== "") run.push(text);
		} else {
			// A tool call, an image: anything else ends the run Pi would render as one.
			endRun();
		}
	}
	endRun();

	return parts;
}

function describe(text: string): string {
	const lines = countLines(text);
	return `${lines} ${lines === 1 ? "line" : "lines"} · ${text.length} ${text.length === 1 ? "char" : "chars"}`;
}

/** Stands in for a part the stage is performing: queued, not yet fully printed. */
export function stagedNotice(text: string): string {
	return `▶ performing · ${describe(text)}`;
}

/** Stands in for a part that is still streaming — it may not have reached the stage yet. */
export function printingNotice(text: string): string {
	return `▶ printing · ${describe(text)}`;
}

/** Stands in for a tool call's block, naming the call — a call has no length to describe. */
export function stagedCall(line: string): string {
	return `▶ performing · ${line}`;
}

/** Stands in for a tool call whose block is drawn before its line has reached the queue. */
export function printingCall(line: string): string {
	return `▶ printing · ${line}`;
}

function firstString(fields: Record<string, unknown>, keys: readonly string[]): string {
	for (const key of keys) {
		const value = fields[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return "";
}

/**
 * The line Pi prints for a tool call, rebuilt from the arguments of the
 * execution event — only a built-in tool can render its own call, and the
 * transformer never sees one.
 *
 * The line is the extension's own text, so it opens a line of its own when the
 * previous character did not end one (`previous` is the last character queued
 * so far) and closes it with a newline. Nothing is inserted inside the model's
 * text.
 */
export function toolCallText(toolName: string, args: unknown, previous: string): string {
	const fields =
		typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : undefined;
	const opening = previous === "" || previous === "\n" ? "" : "\n";
	// Pi shows a call with no path as the working directory, and "." reads as that.
	const path = fields ? firstString(fields, ["file_path", "path"]) || "." : ".";

	switch (toolName) {
		case "bash":
			return `${opening}$ ${fields ? firstString(fields, ["command"]) : ""}\n`;
		case "powershell":
			return `${opening}PS> ${fields ? firstString(fields, ["command"]) : ""}\n`;
		case "read":
		case "write":
		case "edit":
		case "ls":
			return `${opening}${toolName} ${path}\n`;
		case "grep":
			return `${opening}grep /${fields ? firstString(fields, ["pattern"]) : ""}/ in ${path}\n`;
		case "find":
			return `${opening}find ${fields ? firstString(fields, ["pattern"]) : ""} in ${path}\n`;
		default: {
			if (!fields) return `${opening}${toolName}\n`;
			const json = JSON.stringify(fields);
			return json === "{}" ? `${opening}${toolName}\n` : `${opening}${toolName} ${json}\n`;
		}
	}
}

/** A notice or a status stays one line: an argument can hold newlines and go on for pages. */
const LONGEST_CALL_LINE = 100;

/** One line naming a tool call, for the places that stand in for one. */
export function callLine(toolName: string, args: unknown, previous = ""): string {
	const line = toolCallText(toolName, args, previous).trim().split("\n")[0] ?? "";
	return line.length <= LONGEST_CALL_LINE ? line : `${line.slice(0, LONGEST_CALL_LINE - 1)}…`;
}
