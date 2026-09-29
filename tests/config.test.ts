import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CONFIG_FILE, DEFAULT_CONFIG, configPath, ensureConfigFile, loadConfig, normalizeConfig, saveConfig } from "../extensions/code-dance/config.ts";

const made: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "code-dance-config-"));
	made.push(dir);
	return dir;
}

after(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

test("the defaults are a working performance", () => {
	assert.equal(DEFAULT_CONFIG.enabled, true);
	assert.equal(DEFAULT_CONFIG.playlistMode, "sequential");
	assert.equal(DEFAULT_CONFIG.stageHeight, 12);
	assert.equal(DEFAULT_CONFIG.showPlaceholder, true);
	assert.equal(DEFAULT_CONFIG.audioCommand, 'ffplay -nodisp -autoexit "{file}"');
	assert.equal(DEFAULT_CONFIG.musicSyncOffsetMs, 300);
	assert.ok(DEFAULT_CONFIG.audioBackend === "wav-soundplayer" || DEFAULT_CONFIG.audioBackend === "command");
});

test("normalizeConfig fills a config out of nothing", () => {
	assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig([]), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig("junk"), DEFAULT_CONFIG);
	assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
});

test("every field is validated on its own", () => {
	const config = normalizeConfig({
		enabled: "yes",
		playlistMode: "random",
		stageHeight: "20",
		showPlaceholder: 1,
		audioBackend: "alsa",
		audioCommand: 42,
		musicSyncOffsetMs: "300",
	});

	// Only a real boolean counts as a choice; the rest fall back one by one.
	assert.equal(config.enabled, true);
	assert.equal(config.playlistMode, "sequential");
	assert.equal(config.stageHeight, 12);
	assert.equal(config.showPlaceholder, true);
	assert.equal(config.audioBackend, DEFAULT_CONFIG.audioBackend);
	assert.equal(config.audioCommand, DEFAULT_CONFIG.audioCommand);
	assert.equal(config.musicSyncOffsetMs, 300);
});

test("a valid config is passed through, with the panel's floor and ceiling", () => {
	const config = normalizeConfig({
		enabled: false,
		playlistMode: "loop-one",
		stageHeight: 1,
		showPlaceholder: false,
		audioBackend: "command",
		audioCommand: "player {file}",
		musicSyncOffsetMs: -300,
	});

	assert.equal(config.enabled, false);
	assert.equal(config.playlistMode, "loop-one");
	// Three rows is the header, the meter and one line of text.
	assert.equal(config.stageHeight, 3);
	assert.equal(config.showPlaceholder, false);
	assert.equal(config.audioBackend, "command");
	assert.equal(config.audioCommand, "player {file}");
	assert.equal(config.musicSyncOffsetMs, -300);

	assert.equal(normalizeConfig({ stageHeight: 999 }).stageHeight, 60);
	assert.equal(normalizeConfig({ stageHeight: 12.6 }).stageHeight, 13);
	assert.equal(normalizeConfig({ stageHeight: Number.NaN }).stageHeight, 12);
	assert.equal(normalizeConfig({ musicSyncOffsetMs: -99999 }).musicSyncOffsetMs, -5000);
	assert.equal(normalizeConfig({ musicSyncOffsetMs: 99999 }).musicSyncOffsetMs, 5000);
});

test("the config file lives under the agent directory", () => {
	const agent = scratch();
	assert.equal(configPath(agent), join(agent, CONFIG_FILE));
});

test("the first run writes a file to edit", () => {
	const agent = join(scratch(), "agent");
	ensureConfigFile(agent);

	const path = configPath(agent);
	assert.ok(existsSync(path));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), DEFAULT_CONFIG);

	// A file that exists is left alone.
	writeFileSync(path, '{"enabled":false}', "utf8");
	ensureConfigFile(agent);
	assert.equal(loadConfig(agent).enabled, false);
});

test("a missing file means defaults, without a warning", () => {
	const warnings: string[] = [];
	assert.deepEqual(loadConfig(join(scratch(), "nothing"), (message) => warnings.push(message)), DEFAULT_CONFIG);
	assert.deepEqual(warnings, []);
});

test("a broken file warns and falls back", () => {
	const agent = scratch();
	writeFileSync(configPath(agent), "{ not json", "utf8");

	const warnings: string[] = [];
	const config = loadConfig(agent, (message, level) => warnings.push(`${level}: ${message}`));
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /^warning: code-dance: 配置无法解析/);
});

test("what was saved is what is loaded", () => {
	const agent = scratch();
	const wanted = normalizeConfig({ enabled: false, playlistMode: "shuffle", stageHeight: 20 });
	saveConfig(agent, wanted);

	assert.deepEqual(loadConfig(agent), wanted);
});
