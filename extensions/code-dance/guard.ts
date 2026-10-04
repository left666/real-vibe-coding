/**
 * The guard: refuses the shell commands that would take pi down with the
 * process they mean to kill.
 *
 * pi runs as a node process, so a command that kills by the image name `node`
 * kills pi itself — and `/F` is a hard kill: no cleanup runs, the terminal is
 * left in raw mode, and the shell then echoes the escape codes of every
 * keypress as garbage. Blocking such a call costs the model one retry; letting
 * it through costs the session, mid-task. So the `tool_call` handler refuses
 * them, and the reason names the kill-by-PID recipe to use instead.
 *
 * The guard is deliberately narrow: only a shell call is read, and only a kill
 * that selects processes by the node image name is refused. A kill that names
 * a PID, or another image, is none of our business.
 */

/** The tools whose input carries a command line. */
const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** An image name that is node itself: `node`, `node.exe`, `node*`, quoted or not. */
const NODE_IMAGE = `["']?node(?:\\.exe)?\\*?["']?(?![\\w.])`;

/** The verbs that stop processes by name: `Stop-Process`, its alias `spps`, and `kill`'s name form. */
const STOP_VERB = `\\b(?:stop-process|spps|kill)\\b`;

/** `Get-Process node | Stop-Process`: the pipeline kills every node the left side names. */
const PIPELINE_INTO_STOP = new RegExp(`\\bget-process\\b[^|\\n]*${NODE_IMAGE}[^|\\n]*\\|[^\\n]*?${STOP_VERB}`, "i");

/** `taskkill /F /IM node.exe`, `//IM node*`, `/FI "IMAGENAME eq node.exe"` — in one and the same command. */
function taskkillsNode(segment: string): boolean {
	if (!/\btaskkill\b/i.test(segment)) return false;
	return (
		new RegExp(`//?IM[\\s:=]+${NODE_IMAGE}`, "i").test(segment) ||
		new RegExp(`IMAGENAME\\s+eq\\s+${NODE_IMAGE}`, "i").test(segment)
	);
}

/** `Stop-Process -Name node`, `spps -Name node*`, `kill -Name node.exe` — with any unambiguous prefix of `-Name`. */
function stopsNode(segment: string): boolean {
	return new RegExp(`${STOP_VERB}[\\s\\S]*?-(?:N(?:a(?:m(?:e)?)?)?|ProcessName)[\\s:=]+${NODE_IMAGE}`, "i").test(segment);
}

/** What the refused call would have done, and the recipe it should use instead. */
const REASON =
	"code-dance: blocked — this command kills processes by the image name \"node\", and pi itself runs as node.exe: it would go down with them, cutting the session off mid-task, and a hard kill also leaves the terminal in raw mode (the shell then echoes every keypress's escape codes as garbage). Kill only the target process instead: find its PID by port first (netstat -ano | findstr :<port>), then taskkill //F //PID <PID>, or Stop-Process -Id <PID> in PowerShell.";

/** One command is the kill when any of its segments is, or when its pipeline pipes node into one. */
function killsNodeByName(command: string): boolean {
	if (PIPELINE_INTO_STOP.test(command)) return true;
	return command.split(/[|;&\n]+/).some((segment) => taskkillsNode(segment) || stopsNode(segment));
}

/**
 * The reason this call is refused, or `undefined` to let it run. Only a shell
 * call is read; anything else — a `write` whose content happens to quote an
 * example, a `grep` looking for one — is left alone.
 */
export function selfKillReason(toolName: string, input: unknown): string | undefined {
	if (!SHELL_TOOLS.has(toolName)) return undefined;
	if (typeof input !== "object" || input === null) return undefined;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string") return undefined;
	return killsNodeByName(command) ? REASON : undefined;
}
