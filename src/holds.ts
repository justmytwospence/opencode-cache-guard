// A held prompt and the ways through it. The server half holds a prompt (chat.message throws) and
// records it in the session's state file; the TUI half offers the choices and acts on them. The two
// halves talk through small files in the state directory, since a TUI plugin has no channel to the
// server plugin and the server can only nudge the TUI (`tui.command.execute`).
//
//   <session>.json         the snapshot, with `held` while a prompt is held and `muted` once asking stopped
//   <session>.confirm.json the TUI (or the Enter-again fallback) authorised this text: the server lets it through once
//   <session>.compact.json guidance for the next compaction of the session, consumed by the compacting hook
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type ColdReason, type Price, type Settings, choiceCosts, compactionFocus, formatCost, formatTokens } from "./core.js";

export interface HeldPrompt {
  /** The prompt as typed (text parts only). */
  text: string;
  /** How the TUI sent it, so a resend goes out the same way. */
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  at: number;
  /** Why the next request misses, worded. */
  line: string;
  reason: ColdReason["kind"];
  /** Prompt tokens the next request re-sends. */
  tokens: number;
  /** Dollars at list prices; absent for a model with no known prices. */
  costs?: { send: number; compact: number };
  /** Distinguishes holds of the same text, so the TUI opens one dialog per hold. */
  seq: number;
}

export function heldPrompt(input: {
  text: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  now: number;
  line: string;
  reason: ColdReason;
  tokens: number;
  price?: Price;
  ttlMs: number;
}): HeldPrompt {
  return {
    text: input.text,
    agent: input.agent,
    model: input.model,
    variant: input.variant,
    at: input.now,
    line: input.line,
    reason: input.reason.kind,
    tokens: input.tokens,
    costs: input.price ? choiceCosts(input.tokens, input.price, input.ttlMs) : undefined,
    seq: input.now,
  };
}

/** The TUI command the server publishes when it holds a prompt, so the dialog opens at once. */
export const HOLD_COMMAND = "cache-guard.held";

export type Choice = "keep" | "compact" | "fresh" | "send" | "mute";

export interface ChoiceOption {
  value: Choice;
  title: string;
  description: string;
}

/** The dialog's options, Keep first so a reflexive Enter is safe. */
export function choiceOptions(held: HeldPrompt): ChoiceOption[] {
  const size = formatTokens(held.tokens);
  const send = held.costs ? ` (~${formatCost(held.costs.send)})` : "";
  const compact = held.costs ? ` (~${formatCost(held.costs.compact)})` : "";
  return [
    { value: "keep", title: "Keep the prompt", description: "Leave it in the box; nothing is sent." },
    { value: "compact", title: `Compact first, then send${compact}`, description: `Summarize the ${size}-token history once, uncached, and continue on the summary.` },
    { value: "fresh", title: "Start fresh with this prompt", description: "A new session with the same agent and model; the history stays here." },
    { value: "send", title: `Send anyway${send}`, description: `Write the ${size}-token history to the cache again.` },
    { value: "mute", title: "Send, and stop asking in this session", description: "Same as sending, and no more holds here." },
  ];
}

export type Guidance = { kind: "default" } | { kind: "focus" } | { kind: "custom" };

export interface GuidanceOption {
  value: Guidance["kind"];
  title: string;
  description: string;
}

export const GUIDANCE_OPTIONS: GuidanceOption[] = [
  { value: "default", title: "Default summary", description: "opencode's own compaction prompt." },
  { value: "focus", title: "Focus on this prompt", description: "Keep what the held prompt needs, drop the rest." },
  { value: "custom", title: "Write guidance...", description: "Your own instructions for the summary." },
];

/** What the compacting hook adds to the compaction prompt for a choice; undefined adds nothing. */
export function guidanceText(kind: Guidance["kind"], held: HeldPrompt, custom?: string): string | undefined {
  if (kind === "focus") return compactionFocus(held.text);
  if (kind === "custom") return custom?.trim() || undefined;
  return undefined;
}

export function confirmFile(dir: string, sessionID: string): string {
  return path.join(dir, `${sessionID}.confirm.json`);
}

export function guidanceFile(dir: string, sessionID: string): string {
  return path.join(dir, `${sessionID}.compact.json`);
}

function writeWhole(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}

/** Authorises one send of `text` in the session (the TUI's choice, or the Enter-again fallback). */
export function writeConfirm(dir: string, sessionID: string, text: string, mute = false): void {
  writeWhole(confirmFile(dir, sessionID), { text: text.trim(), at: Date.now(), mute });
}

/**
 * Takes the session's confirmation if it authorises `text`: true when it did (the file is removed
 * either way, so a stale one never lets a later prompt through). `mute` comes back with it.
 */
export function takeConfirm(dir: string, sessionID: string, text: string, now: number, windowMs: number): { confirmed: boolean; mute: boolean } {
  const file = confirmFile(dir, sessionID);
  let record: { text?: string; at?: number; mute?: boolean } | undefined;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { confirmed: false, mute: false };
  }
  rmSync(file, { force: true });
  const confirmed = record?.text === text.trim() && typeof record.at === "number" && now - record.at <= windowMs;
  return { confirmed, mute: confirmed && record?.mute === true };
}

/** Leaves guidance for the session's next compaction. */
export function writeGuidance(dir: string, sessionID: string, text: string): void {
  writeWhole(guidanceFile(dir, sessionID), { text, at: Date.now() });
}

/** Takes the session's compaction guidance, if any was left recently (an hour), removing it. */
export function takeGuidance(dir: string, sessionID: string, now: number): string | undefined {
  const file = guidanceFile(dir, sessionID);
  let record: { text?: string; at?: number } | undefined;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  rmSync(file, { force: true });
  if (typeof record?.text !== "string" || typeof record.at !== "number" || now - record.at > 3_600_000) return undefined;
  return record.text;
}

/** Whether a settings object and a snapshot say the TUI should offer the dialog for this hold. */
export function shouldOffer(settings: Settings, held: HeldPrompt | undefined, seen: number | undefined): held is HeldPrompt {
  return !!held && settings.enabled && settings.warn.enabled && held.seq !== seen;
}
