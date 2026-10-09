import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_SETTINGS, NAME, type Settings, mergeSettings } from "./core.js";

/**
 * Shared `~/.config/agents/cache-guard.json`, then `~/.config/opencode/cache-guard.json`, then the
 * plugin's options in `opencode.jsonc` (`["opencode-cache-guard@...", { ... }]`), then the
 * project's `.agents/cache-guard.json` and `.opencode/cache-guard.json`, each on top of the last
 * (objects merge, other values replace). Unreadable or invalid files are ignored.
 */
export function loadSettings(directory: string, env: NodeJS.ProcessEnv = process.env, options?: Record<string, unknown>): Settings {
  const read = (file: string) => {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  return mergeSettings(DEFAULT_SETTINGS, [
    read(path.join(sharedConfigDir(env), `${NAME}.json`)),
    read(userSettingsFile(env)),
    options ? JSON.stringify(options) : undefined,
    read(path.join(directory, ".agents", `${NAME}.json`)),
    read(path.join(directory, ".opencode", `${NAME}.json`)),
  ]);
}

/** `$XDG_CONFIG_HOME/agents` (default `~/.config/agents`): settings shared with the other ports. */
export function sharedConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agents");
}

/** `~/.config/opencode/cache-guard.json`: the opencode-only user file, which the Jev command writes. */
export function userSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode", `${NAME}.json`);
}

/**
 * Merge `patch` into the opencode-only user settings file (objects merge, other values replace).
 * Throws when the file exists but is not a JSON object, rather than overwrite it.
 */
export function saveUserSettings(patch: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string {
  const file = userSettingsFile(env);
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(value)) throw new Error(`${file} is not a JSON object`);
    current = value;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(merge(current, patch), null, 2)}\n`);
  return file;
}

/** Where the server plugin leaves each session's cache state for the TUI, and its log. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), `opencode-${NAME}`);
}

/** `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`): where opencode keeps its data, and this plugin the full tool output it trimmed. */
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode");
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? merge(current, value) : value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
