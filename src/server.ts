// opencode-cache-guard (server): keeps the Anthropic prompt cache warm between turns by sending
// the session's last request again with a one-token output cap, asks before a prompt that would
// re-cache a large conversation (it holds the prompt; the TUI half offers the choices: keep,
// compact first, start fresh, send), and leaves each session's cache clock in a state file for the
// TUI half.
//
// opencode sends Anthropic cache markers without a TTL, so the cache lives 5 minutes from each
// request's start. src/core.ts is shared with the pi, Claude Code and Codex ports unchanged.
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Hooks, Plugin } from "@opencode-ai/plugin";

import {
  type ColdReason,
  ConfirmMemo,
  NAME,
  type Price,
  type Settings,
  claudePrice,
  describeMiss,
  missCost,
  worthWarning,
} from "./core.js";
import { SESSION_HEADER, install, uninstall } from "./fetch.js";
import { HOLD_COMMAND, confirmFile, guidanceFile, heldPrompt, takeConfirm, takeGuidance } from "./holds.js";
import { loadSettings, stateDir } from "./settings.js";
import { ANTHROPIC_TTL_MS, type ModelRef, type SessionSnapshot, type SessionState, Warmer, sameModel } from "./warmer.js";

/** Agents opencode runs for itself; their requests carry no tools and are not the session's cache. */
const HIDDEN_AGENTS = new Set(["title", "summary", "compaction"]);
/** How long after the hold the explanation toast goes up, past the TUI's own error toast. */
const TOAST_DELAY_MS = 400;

interface CostLike {
  input?: number;
  cache?: { read?: number; write?: number };
}

/**
 * The model's prices per million tokens from opencode's catalog; list prices when the auth plugin
 * zeroed them (it does for an OAuth subscription, whose usage still scales the same way).
 */
export function priceOf(model: ModelRef, cost?: CostLike): Price | undefined {
  if (cost && (cost.input ?? 0) > 0) {
    return { input: cost.input!, cacheRead: cost.cache?.read ?? 0, cacheWrite: (cost.cache?.write ?? 0) > 0 ? cost.cache!.write : undefined };
  }
  return model.providerID === "anthropic" ? claudePrice(model.modelID) : undefined;
}

export function ttlOf(model: ModelRef, env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (model.providerID !== "anthropic") return undefined;
  // For testing: a short TTL makes a session go cold in seconds.
  const override = Number(env.OPENCODE_CACHE_GUARD_TTL_MS);
  return Number.isFinite(override) && override > 0 ? override : ANTHROPIC_TTL_MS;
}

/** Why the session's next request misses, if it does. */
export function coldReason(state: Pick<SessionState, "lastAt" | "ttlMs" | "model">, model: ModelRef | undefined, now: number, settings: Settings): ColdReason | undefined {
  if (!state.lastAt) return undefined;
  if (model && state.model && !sameModel(model, state.model)) return { kind: "model", from: state.model.modelID, to: model.modelID };
  const idleMs = Math.max(0, now - state.lastAt);
  if (state.ttlMs !== undefined) return idleMs > state.ttlMs ? { kind: "expired", idleMs: idleMs - state.ttlMs } : undefined;
  return idleMs >= settings.warn.idleMinutes * 60_000 ? { kind: "idle", idleMs } : undefined;
}

/** The prompt's own text: what the user typed, not what opencode attached. */
export function promptText(parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>): string {
  return parts
    .filter((part) => part.type === "text" && !part.synthetic && typeof part.text === "string")
    .map((part) => part.text!)
    .join("\n")
    .trim();
}

export const CacheGuardPlugin: Plugin = async ({ client, directory }) => {
  let settings = loadSettings(directory);
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const log = (line: string) => {
    try {
      appendFileSync(path.join(dir, "log.txt"), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging is best effort.
    }
  };
  // Tiny files, written whole so the TUI never reads half of one.
  const write = (snapshot: SessionSnapshot) => {
    const file = path.join(dir, `${snapshot.sessionID}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(snapshot));
      renameSync(temporary, file);
    } catch {
      // The TUI shows nothing for this session until the next write.
    }
  };
  const delayMs = Number(process.env.OPENCODE_CACHE_GUARD_WARM_DELAY_MS);
  const memo = new ConfirmMemo();
  const prices = new Map<string, Price | undefined>();
  const restored = new Set<string>();
  let lastParamsSession: string | undefined;

  const original = install((record) => {
    const sessionID = record.sessionID ?? lastParamsSession;
    if (!sessionID) return;
    log(`${sessionID} request recorded (${record.body.length} bytes, session from ${record.sessionVia ?? "the last chat.params"})`);
    warmer.recordRequest(sessionID, record);
  });
  const warmer = new Warmer({
    settings: () => settings,
    fetch: (url, init) => original(url, init),
    log,
    onChange: write,
    delayMs: Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined,
  });

  /** A session this process has not seen a request for (resumed): its clock from its last reply. */
  const restore = async (sessionID: string): Promise<SessionState | undefined> => {
    if (restored.has(sessionID)) return warmer.sessions.get(sessionID);
    restored.add(sessionID);
    try {
      const result = await client.session.messages({ path: { id: sessionID } });
      const messages = (result.data ?? []) as Array<{ info: Record<string, any> }>;
      for (let index = messages.length - 1; index >= 0; index--) {
        const info = messages[index]!.info;
        if (info.role !== "assistant" || !info.tokens) continue;
        const tokens = (info.tokens.input ?? 0) + (info.tokens.cache?.read ?? 0) + (info.tokens.cache?.write ?? 0) + (info.tokens.output ?? 0);
        if (tokens <= 0) continue;
        const model: ModelRef = { providerID: info.providerID, modelID: info.modelID };
        return warmer.restore(sessionID, {
          at: info.time?.completed ?? info.time?.created ?? 0,
          tokens,
          model,
          ttlMs: ttlOf(model),
          price: prices.get(`${model.providerID}/${model.modelID}`) ?? priceOf(model),
        });
      }
    } catch {
      // No history to read: nothing to warn about.
    }
    return undefined;
  };

  const hooks: Hooks = {
    dispose: async () => {
      uninstall();
      warmer.dispose();
    },
    "chat.params": async (input) => {
      if (HIDDEN_AGENTS.has(input.agent)) return;
      const model: ModelRef = { providerID: input.model.providerID, modelID: input.model.id };
      const price = priceOf(model, input.model.cost);
      prices.set(`${model.providerID}/${model.modelID}`, price);
      restored.add(input.sessionID);
      warmer.setModel(input.sessionID, model, price, ttlOf(model));
      lastParamsSession = input.sessionID;
    },
    "chat.headers": async (input, output) => {
      if (HIDDEN_AGENTS.has(input.agent) || input.model.providerID !== "anthropic") return;
      output.headers[SESSION_HEADER] = input.sessionID;
    },
    event: async ({ event }) => {
      const type = event.type as string;
      const properties = (event as { properties: Record<string, any> }).properties;
      if (type === "message.updated") {
        const info = properties.info;
        if (info?.role !== "assistant" || !info.tokens) return;
        const tokens = (info.tokens.input ?? 0) + (info.tokens.cache?.read ?? 0) + (info.tokens.cache?.write ?? 0) + (info.tokens.output ?? 0);
        warmer.recordTokens(info.sessionID, tokens, { providerID: info.providerID, modelID: info.modelID }, info.time?.created);
      } else if (type === "session.status") {
        warmer.setBusy(properties.sessionID, properties.status?.type !== "idle");
      } else if (type === "session.idle") {
        warmer.setBusy(properties.sessionID, false);
      } else if (type === "session.created" || type === "session.updated") {
        if (properties.info?.parentID) warmer.setChild(properties.info.id, true);
      } else if (type === "session.compacted") {
        warmer.reset(properties.sessionID);
      } else if (type === "session.deleted") {
        const id = properties.info?.id;
        warmer.sessions.delete(id);
        if (id) for (const file of [path.join(dir, `${id}.json`), confirmFile(dir, id), guidanceFile(dir, id)]) rmSync(file, { force: true });
      }
    },
    // Guidance the TUI left for a compaction it asked for ("Focus on this prompt", or written).
    "experimental.session.compacting": async (input, output) => {
      const guidance = takeGuidance(dir, input.sessionID, Date.now());
      if (guidance) output.context.push(guidance);
    },
    "chat.message": async (input, output) => {
      settings = loadSettings(directory);
      if (!settings.enabled || !settings.warn.enabled) return;
      const text = promptText(output.parts as Array<{ type: string; text?: string; synthetic?: boolean }>);
      if (!text) return;
      const state = warmer.sessions.get(input.sessionID)?.lastAt ? warmer.sessions.get(input.sessionID) : await restore(input.sessionID);
      if (!state?.lastAt) return;
      const now = Date.now();
      const windowMs = settings.warn.confirmSeconds * 1000;
      // A choice the TUI made for this text, or an earlier hold of it: this send is authorised.
      const confirm = takeConfirm(dir, input.sessionID, text, now, windowMs);
      if (confirm.mute) warmer.setMuted(input.sessionID, true);
      const authorised = confirm.confirmed || memo.confirmed(input.sessionID, text, now, windowMs);
      if (state.held) warmer.setHeld(input.sessionID, undefined);
      if (authorised || state.muted) return;
      const reason = coldReason(state, input.model, now, settings);
      if (!reason) return;
      const next = reason.kind === "model" && input.model ? input.model : state.model;
      const price = next ? (prices.get(`${next.providerID}/${next.modelID}`) ?? priceOf(next)) : undefined;
      const ttlMs = state.ttlMs ?? ANTHROPIC_TTL_MS;
      const cost = price ? missCost(state.tokens, price, ttlMs) : undefined;
      if (!worthWarning(state.tokens, cost, settings)) return;
      memo.arm(input.sessionID, text, now);
      const minutes = Math.round(settings.warn.confirmSeconds / 60);
      const message = describeMiss(reason, state.tokens, cost);
      log(`${input.sessionID} held a prompt: ${message}`);
      const message_ = output.message as { agent?: string; model?: { providerID: string; modelID: string; variant?: string } };
      const model = input.model ?? (message_.model ? { providerID: message_.model.providerID, modelID: message_.model.modelID } : undefined);
      warmer.setHeld(input.sessionID, heldPrompt({
        text, agent: input.agent ?? message_.agent, model, variant: input.variant ?? message_.model?.variant,
        now, line: message, reason, tokens: state.tokens, price, ttlMs,
      }));
      // The TUI cleared its input when it sent the prompt; put the text back for the second Enter.
      await client.tui.appendPrompt({ body: { text } }).catch(() => undefined);
      // The TUI half, when loaded, opens the choice dialog on this command; without it, the toast
      // below says what to do.
      await client.tui.publish({ body: { type: "tui.command.execute", properties: { command: HOLD_COMMAND } } }).catch(() => undefined);
      // The TUI shows one toast at a time and answers the failed send with a generic error toast
      // of its own; this one lands just after it and takes its place.
      setTimeout(() => {
        void client.tui
          .showToast({ body: { title: "Prompt cache miss", message: `${message} Press Enter again within ${minutes} min to send it anyway; /compact or /new first is cheaper.`, variant: "warning", duration: 12_000 } })
          .catch(() => undefined);
      }, TOAST_DELAY_MS).unref?.();
      throw new Error(`${NAME} held this prompt. Press Enter again within ${minutes} min to send it anyway.`);
    },
  };
  return hooks;
};

export default { id: `opencode-${NAME}`, server: CacheGuardPlugin };
