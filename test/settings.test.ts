import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { DEFAULT_SETTINGS } from "../src/core.js";
import { loadSettings, opencodeDataDir, saveUserSettings, stateDir, userSettingsFile } from "../src/settings.js";

let config: string;
let project: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  config = mkdtempSync(path.join(tmpdir(), "cg-config-"));
  project = mkdtempSync(path.join(tmpdir(), "cg-project-"));
  env = { XDG_CONFIG_HOME: config };
});
afterEach(() => {
  rmSync(config, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

test("defaults when nothing is configured, including the Jev, trim and compact keys", () => {
  const s = loadSettings(project, env);
  expect(s).toEqual(DEFAULT_SETTINGS);
  expect(s.jev).toEqual({ enabled: true, provider: "", model: "", timeoutMs: 2_500 });
  expect(s.trim.minChars).toBe(12_000);
  expect(s.compact).toEqual({ filter: true, timeoutMs: 10_000, concurrency: 4 });
});

test("layers merge: shared user file, opencode user file, plugin options, project .agents, project .opencode", () => {
  write(path.join(config, "agents", "cache-guard.json"), { jev: { model: "jev-1.13", timeoutMs: 4_000 }, trim: { minChars: 8_000 }, warn: { minCost: 1 } });
  write(path.join(config, "opencode", "cache-guard.json"), { jev: { enabled: false }, compact: { concurrency: 2 } });
  write(path.join(project, ".agents", "cache-guard.json"), { trim: { headLines: 10 } });
  write(path.join(project, ".opencode", "cache-guard.json"), { compact: { filter: false } });
  const s = loadSettings(project, env, { jev: { enabled: true, provider: "typesafe" }, trim: { toast: false } });
  expect(s.jev).toEqual({ enabled: true, provider: "typesafe", model: "jev-1.13", timeoutMs: 4_000 });
  expect(s.trim).toMatchObject({ minChars: 8_000, readMinChars: 50_000, headLines: 10, toast: false });
  expect(s.compact).toEqual({ filter: false, timeoutMs: 10_000, concurrency: 2 });
  expect(s.warn.minCost).toBe(1);
  // Invalid files are skipped.
  write(path.join(project, ".opencode", "cache-guard.json"), "{not json");
  expect(loadSettings(project, env).compact.filter).toBe(true);
});

test("saveUserSettings merges into ~/.config/opencode/cache-guard.json and refuses a file that is not an object", () => {
  const file = userSettingsFile(env);
  expect(file).toBe(path.join(config, "opencode", "cache-guard.json"));
  expect(saveUserSettings({ jev: { enabled: false } }, env)).toBe(file);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jev: { enabled: false } });
  write(file, { warn: { minCost: 2 }, jev: { model: "jev-1.13", enabled: false } });
  saveUserSettings({ jev: { enabled: true } }, env);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ warn: { minCost: 2 }, jev: { model: "jev-1.13", enabled: true } });
  expect(loadSettings(project, env).jev).toMatchObject({ enabled: true, model: "jev-1.13" });
  write(file, "[1, 2]");
  expect(() => saveUserSettings({ jev: { enabled: false } }, env)).toThrow(/not a JSON object/u);
  expect(readFileSync(file, "utf8")).toBe("[1, 2]");
  write(file, "{oops");
  expect(() => saveUserSettings({ jev: { enabled: false } }, env)).toThrow();
});

test("directories follow XDG", () => {
  expect(stateDir({ XDG_CACHE_HOME: "/c" })).toBe("/c/opencode-cache-guard");
  expect(opencodeDataDir({ XDG_DATA_HOME: "/d" })).toBe("/d/opencode");
});
