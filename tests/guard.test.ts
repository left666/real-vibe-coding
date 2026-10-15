import assert from "node:assert/strict";
import { test } from "node:test";

import { selfKillReason } from "../extensions/real-vibe-coding/guard.ts";

/** The guard's answer for a command run through a shell tool. */
function refuses(command: string, toolName = "bash"): boolean {
	return selfKillReason(toolName, { command }) !== undefined;
}

test("a kill by the node image name is refused, in every spelling seen in the wild", () => {
	const refused = [
		// taskkill, either slash style, either way of naming the image.
		"taskkill /F /IM node.exe",
		"taskkill //F //IM node.exe",
		"TASKKILL /IM node* /T",
		"taskkill /IM:node.exe /F",
		'taskkill /FI "IMAGENAME eq node.exe"',
		'taskkill /FI "IMAGENAME EQ node*"',
		// Stop-Process and its aliases, by whatever name the selection takes.
		"Stop-Process -Name node -Force",
		"stop-process -name node.exe",
		"spps -Name node*",
		"kill -Name node",
		'powershell -Command "Stop-Process -Name node -Force"',
		// Selections that pipe every node into the kill.
		"Get-Process node | Stop-Process",
		"Get-Process -Name node.exe | kill",
		// Wrapped in another shell, the command is still the command.
		'cmd //c "taskkill /F /IM node.exe"',
	];
	for (const command of refused) assert.ok(refuses(command), command);
});

test("a kill that names a PID, or another image, goes through", () => {
	const allowed = [
		"taskkill /F /PID 1234",
		"taskkill //F //PID 1234",
		"taskkill /PID 1234 /T",
		"taskkill /F /IM notepad.exe",
		"Stop-Process -Id 1234",
		"kill -9 1234",
		"kill 1234",
		"Get-Process node",
		"netstat -ano | findstr :3000",
		"node --version",
		"npm run build",
		'echo "IMAGENAME eq node.exe"',
	];
	for (const command of allowed) assert.equal(selfKillReason("bash", { command }), undefined, command);
});

test("only a shell call is read, and only its command", () => {
	assert.ok(refuses("Stop-Process -Name node", "powershell"));
	assert.equal(selfKillReason("write", { command: "taskkill /F /IM node.exe" }), undefined);
	assert.equal(selfKillReason("grep", { pattern: "IMAGENAME eq node.exe" }), undefined);
	assert.equal(selfKillReason("bash", {}), undefined);
	assert.equal(selfKillReason("bash", { command: 42 }), undefined);
	assert.equal(selfKillReason("bash", undefined), undefined);
});

test("the refusal names the recipe that would not have killed pi", () => {
	const reason = selfKillReason("bash", { command: "taskkill //F //IM node.exe" });
	assert.ok(reason);
	assert.match(reason, /node\.exe/);
	assert.match(reason, /PID/);
	assert.match(reason, /Stop-Process -Id/);
});
