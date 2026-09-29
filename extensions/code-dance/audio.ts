/**
 * Audio playback.
 *
 * The contract is deliberately narrow: play one file, resolve when it ends,
 * stop on demand. CodeDance keeps its own clock on the MIDI timeline, so a
 * backend never has to report a position.
 *
 * Nothing is bundled for synthesis. Rendering a `.mid` needs a SoundFont the
 * user may not have, and every zero-build Node audio package needs node-gyp, so
 * the default hands a pre-rendered `.wav` to the OS player and anything else is
 * a user-supplied argv template.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type PlaybackResult = "ended" | "stopped";

export interface AudioBackend {
	/** Resolves when playback finishes, or "stopped" if `stop()` cut it short. Rejects when the player cannot start. */
	play(file: string): Promise<PlaybackResult>;
	stop(): void;
}

interface Launch {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
}

/**
 * Windows' own WAV player. The path travels in an environment variable rather
 * than on the command line: PowerShell's `-Command` re-parses trailing
 * arguments, which shreds a path with spaces in it.
 *
 * `PlaySync` blocks until the sound ends, so the process exiting *is* the
 * end-of-track signal and killing it stops the sound immediately.
 */
const SOUND_PLAYER_SCRIPT =
	"(New-Object System.Media.SoundPlayer -ArgumentList $env:CODEDANCE_WAV).PlaySync()";

function spawnBackend(launch: (file: string) => Launch): AudioBackend {
	let player: ChildProcess | null = null;
	let interrupted = false;

	return {
		play(file: string): Promise<PlaybackResult> {
			interrupted = false;
			const spec = launch(file);

			return new Promise<PlaybackResult>((resolve, reject) => {
				let settled = false;
				const child = spawn(spec.command, spec.args, {
					stdio: "ignore",
					windowsHide: true,
					env: spec.env,
				});
				player = child;

				child.on("error", (error) => {
					if (settled) return;
					settled = true;
					player = null;
					reject(error);
				});

				child.on("close", (code) => {
					if (settled) return;
					settled = true;
					player = null;
					if (interrupted) resolve("stopped");
					else if (code === 0 || code === null) resolve("ended");
					else reject(new Error(`player exited with code ${code}`));
				});
			});
		},

		stop(): void {
			interrupted = true;
			player?.kill();
		},
	};
}

export function createSoundPlayerBackend(): AudioBackend {
	return spawnBackend((file) => ({
		command: "powershell.exe",
		args: ["-NoProfile", "-NonInteractive", "-Command", SOUND_PLAYER_SCRIPT],
		// A fresh env per launch keeps the path out of the command line entirely.
		env: { ...process.env, CODEDANCE_WAV: file },
	}));
}

const BLANKS = new Set([" ", "\t", "\n", "\r"]);

/** Split an argv template on whitespace, honouring one level of quotes. */
function splitArgv(template: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote = "";
	let started = false;

	for (const char of template) {
		if (quote !== "") {
			if (char === quote) quote = "";
			else token += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (BLANKS.has(char)) {
			if (started) tokens.push(token);
			token = "";
			started = false;
		} else {
			token += char;
			started = true;
		}
	}
	if (started) tokens.push(token);

	return tokens;
}

/**
 * Split an argv template and substitute `{file}`.
 *
 * The split happens *before* the substitution, so a path with spaces stays a
 * single argument however the template is written, and nothing goes through a
 * shell — a path can never turn into a command.
 */
export function parseCommandTemplate(template: string, file: string): { command: string; args: string[] } {
	const tokens = splitArgv(template).map((token) => token.replaceAll("{file}", file));
	const [command, ...args] = tokens;
	if (command === undefined) throw new Error("code-dance: audioCommand is empty");
	return { command, args };
}

export function createCommandBackend(template: string): AudioBackend {
	return spawnBackend((file) => {
		const { command, args } = parseCommandTemplate(template, file);
		return { command, args };
	});
}

export function createAudioBackend(kind: "wav-soundplayer" | "command", template: string): AudioBackend {
	return kind === "command" ? createCommandBackend(template) : createSoundPlayerBackend();
}
