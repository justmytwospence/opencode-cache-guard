// Trimming large tool output with Jev as it arrives (`tool.execute.after`), before it enters the
// context, so the prompt cache is never disturbed: Jev picks the blocks the agent needs for its
// current step; the rest becomes `[… N lines omitted …]` markers and the full output is saved to
// a file the agent can read. The algorithm is `lean.ts`; this file is what is opencode's: the
// tools, opencode's own truncation file, the session's messages, the log and the toast.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { NAME, type Settings } from "./core.js";
import { type Ask, resolveJev } from "./jev.js";
import { type TrimLimits, blocksFor, trimQuestions, trimState, trimVerdict } from "./lean.js";
import { opencodeDataDir } from "./settings.js";
import { type MessageLike, recentTexts } from "./units.js";

/** opencode's built-in tools whose output must stay whole: edits, plans, subagent answers, skills. */
const WHOLE = new Set(["edit", "write", "apply_patch", "patch", "multiedit", "task", "todowrite", "todoread", "skill", "question", "lsp", "invalid", "batch"]);

/**
 * Which tools' output may be trimmed, and from what size: `read` from `readMinChars`; `bash`,
 * `grep`, `glob`, `list`, `webfetch`, `websearch`, MCP tools (`<server>_<tool>`) and other
 * plugin tools from `minChars`.
 */
export function trimFloor(tool: string, limits: TrimLimits): number | undefined {
  if (tool === "read") return limits.readMinChars;
  if (WHOLE.has(tool)) return undefined;
  return limits.minChars;
}

/** Where full output is saved: `~/.local/share/opencode/cache-guard/tool-output/<session>/<call>.txt`. */
export function savePath(sessionID: string, callID: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = (s: string) => s.replace(/[^\w.-]/gu, "_");
  return path.join(opencodeDataDir(env), NAME, "tool-output", safe(sessionID), `${safe(callID)}.txt`);
}

/** opencode's own truncation directory: `~/.local/share/opencode/tool-output`. */
export function opencodeOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(opencodeDataDir(env), "tool-output");
}

/** Largest full output read back from opencode's truncation file. */
export const MAX_FULL_BYTES = 8 * 1024 * 1024;

/**
 * The whole output when opencode truncated it (it keeps only a head or tail preview and saves the
 * rest under its tool-output directory, naming the file in a hint), so Jev can pick from all of it
 * rather than from the preview. Undefined when there is no such file or it cannot be read.
 */
export function untruncated(text: string, dir = opencodeOutputDir()): string | undefined {
  const match = /Full output saved to: (\S+)/u.exec(text);
  if (!match) return undefined;
  const file = path.resolve(match[1]!);
  if (path.dirname(file) !== path.resolve(dir)) return undefined;
  try {
    if (statSync(file).size > MAX_FULL_BYTES) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether the port-only `trim.toast` key (default true) asks for a toast after each trim. */
export function toastWanted(settings: Settings): boolean {
  return (settings.trim as { toast?: unknown }).toast !== false;
}

export interface TrimInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
}

export interface Trimmer {
  /** The `tool.execute.after` hook: replaces `output.output` when Jev trims it. */
  afterTool(input: TrimInput, output: { output: string }): Promise<void>;
  /** A new prompt in the session: the same call may be trimmed again. */
  newTurn(sessionID: string): void;
  forget(sessionID: string): void;
  /** Characters kept out of the context so far. */
  savedChars(): number;
}

export interface TrimDeps {
  /** The settings in force now, read on each call so edits apply without a restart. */
  settings: () => Settings;
  /** The session's messages, for the agent's current step; empty when they cannot be read. */
  messages: (sessionID: string) => Promise<MessageLike[]>;
  /** Jev, with the timeout and key of this call (`jev.timeoutMs`). */
  ask: (settings: Settings) => Ask;
  log: (line: string) => void;
  toast: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

export function createTrimmer(deps: TrimDeps): Trimmer {
  /** Per session, the tool calls trimmed this turn: the agent asking again gets everything. */
  const trimmed = new Map<string, Set<string>>();
  let saved = 0;
  return {
    newTurn: (sessionID) => trimmed.delete(sessionID),
    forget: (sessionID) => trimmed.delete(sessionID),
    savedChars: () => saved,
    afterTool: async (input, output) => {
      const settings = deps.settings();
      if (!settings.enabled || !settings.trim.enabled) return;
      const floor = trimFloor(input.tool, settings.trim);
      if (floor === undefined) return;
      const original = output.output;
      if (typeof original !== "string" || original.length <= floor) return;
      const jev = resolveJev(settings, deps.env);
      if (jev.kind !== "ready") return;
      const text = untruncated(original, opencodeOutputDir(deps.env)) ?? original;
      const key = `${input.tool}:${JSON.stringify(input.args) ?? ""}`;
      if (trimmed.get(input.sessionID)?.has(key)) return;

      const { lines, blocks } = blocksFor(text, settings.trim);
      const texts = recentTexts(await deps.messages(input.sessionID));
      const state = trimState({ user_request: texts.user || "(unknown)", agent_said: texts.assistant, tool: input.tool, arguments: JSON.stringify(input.args) ?? "" }, blocks);
      const outcome = await deps.ask(settings)(state, trimQuestions(blocks));
      if (!outcome.ok) {
        deps.log(`${input.tool}: left whole, Jev unavailable (${outcome.reason})`);
        return;
      }
      const fullPath = savePath(input.sessionID, input.callID, deps.env);
      const verdict = trimVerdict(lines, blocks, outcome.answers, settings.trim, fullPath);
      const detail = `needs_all ${verdict.needsAll.toFixed(2)}, ${blocks.length} blocks, ${outcome.latencyMs} ms${outcome.inputTokens ? `, ${outcome.inputTokens} tokens` : ""}`;
      if (verdict.trim && verdict.text.length >= original.length) {
        deps.log(`${input.tool}: left opencode's preview, the trim of the full output is no smaller (${detail})`);
        return;
      }
      if (!verdict.trim) {
        deps.log(`${input.tool}: left whole, ${verdict.keptLines} of ${verdict.totalLines} lines needed (${detail})`);
        return;
      }
      try {
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, text);
      } catch (error) {
        deps.log(`${input.tool}: left whole, cannot save ${fullPath} (${error instanceof Error ? error.message : String(error)})`);
        return;
      }
      const keys = trimmed.get(input.sessionID) ?? new Set<string>();
      keys.add(key);
      trimmed.set(input.sessionID, keys);
      output.output = verdict.text;
      saved += original.length - verdict.text.length;
      const tokens = Math.round((original.length - verdict.text.length) / 4_000);
      deps.log(`${input.tool}: kept ${verdict.keptLines} of ${verdict.totalLines} lines, about ${tokens}k tokens saved (${detail}); full output ${fullPath}`);
      if (toastWanted(settings)) deps.toast(`${input.tool} output trimmed to ${verdict.keptLines} of ${verdict.totalLines} lines`);
    },
  };
}
