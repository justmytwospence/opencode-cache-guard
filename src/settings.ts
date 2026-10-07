import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_SETTINGS, NAME, type Settings, mergeSettings } from "./core.js";

/**
 * Shared `~/.config/agents/cache-guard.json`, then `~/.config/opencode/cache-guard.json`, then the
 * project's `.agents/cache-guard.json` and `.opencode/cache-guard.json`, each on top of the last
 * (objects merge, other values replace). Unreadable or invalid files are ignored.
 */
export function loadSettings(directory: string, env: NodeJS.ProcessEnv = process.env): Settings {
  const config = env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  const files = [
    path.join(config, "agents", `${NAME}.json`),
    path.join(config, "opencode", `${NAME}.json`),
    path.join(directory, ".agents", `${NAME}.json`),
    path.join(directory, ".opencode", `${NAME}.json`),
  ];
  return mergeSettings(
    DEFAULT_SETTINGS,
    files.map((file) => {
      try {
        return existsSync(file) ? readFileSync(file, "utf8") : undefined;
      } catch {
        return undefined;
      }
    }),
  );
}

/** Where the server plugin leaves each session's cache state for the TUI, and its log. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), `opencode-${NAME}`);
}
