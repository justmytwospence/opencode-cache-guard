// opencode's messages (`client.session.messages`: `{ info, parts }` each) in and out of `lean.ts`:
// the units Jev judges for a compaction, the files the conversation touched, and the agent's
// current step for a trim.
import { type FileOps, type Unit, clip, finishUnits } from "./lean.js";

/** The part of an opencode message this reads. */
export interface MessageLike {
  info: { role: string; summary?: boolean; [key: string]: unknown };
  parts: ReadonlyArray<PartLike>;
}

export interface PartLike {
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  /** Tool parts. */
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

/** The text a user typed, or an assistant wrote: text parts that are neither synthetic nor ignored. */
export function messageText(message: MessageLike): string {
  return message.parts
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

export interface Extracted {
  units: Unit[];
  /** The last compaction summary opencode wrote, when the history has one; the units start after it. */
  previousSummary?: string;
  fileOps: FileOps;
}

/**
 * Split messages into units: each user text, each assistant text, and each tool call with its
 * result (opencode keeps the call, its input and its output or error in one part). Messages up to
 * the last compaction summary are already covered by that summary.
 */
export function extractUnits(messages: readonly MessageLike[], prefix = "U"): Extracted {
  let start = 0;
  let previousSummary: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as MessageLike;
    if (message.info.role === "assistant" && message.info.summary === true) {
      previousSummary = messageText(message).trim() || undefined;
      start = i + 1;
      break;
    }
  }
  const units: Unit[] = [];
  const fileOps: FileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
  const id = () => `${prefix}${String(units.length + 1).padStart(3, "0")}`;
  for (let index = start; index < messages.length; index++) {
    const message = messages[index] as MessageLike;
    if (message.info.role === "user") {
      const text = messageText(message).trim();
      if (text) units.push({ id: id(), kind: "user", text, message: index });
    } else if (message.info.role === "assistant") {
      const text = messageText(message).trim();
      if (text) units.push({ id: id(), kind: "assistant", text, message: index });
      for (const part of message.parts) {
        if (part.type !== "tool") continue;
        const state = part.state ?? {};
        const name = String(part.tool ?? "tool");
        const input = state.input ?? {};
        const isError = state.status === "error";
        const result = isError ? String(state.error ?? "") : typeof state.output === "string" ? state.output : "";
        units.push({
          id: id(),
          kind: "tool",
          text: "",
          tool: { name, args: JSON.stringify(input), result, isError, callId: String(part.callID ?? "") },
          message: index,
        });
        noteFile(fileOps, name, input);
      }
    }
  }
  return { units: finishUnits(units), previousSummary, fileOps };
}

function noteFile(ops: FileOps, tool: string, input: unknown) {
  const file = input && typeof input === "object" ? (input as { filePath?: unknown }).filePath : undefined;
  if (typeof file !== "string" || !file) return;
  if (tool === "read") (ops.read as Set<string>).add(file);
  else if (tool === "write") (ops.written as Set<string>).add(file);
  else if (tool === "edit" || tool === "multiedit" || tool === "patch" || tool === "apply_patch") (ops.edited as Set<string>).add(file);
}

/** The latest user message and the assistant's latest text after it: the agent's current step. */
export function recentTexts(messages: readonly MessageLike[]): { user: string; assistant: string } {
  let user = "";
  let assistant = "";
  for (let i = messages.length - 1; i >= 0 && (!user || !assistant); i--) {
    const message = messages[i] as MessageLike;
    const text = messageText(message).trim();
    if (!text) continue;
    if (!user && message.info.role === "user") user = text;
    if (!assistant && !user && message.info.role === "assistant") assistant = text;
  }
  return { user, assistant };
}

/** The last `count` user messages, oldest first: the goal of a compaction when none is given. */
export function lastUserMessages(messages: readonly MessageLike[], count: number): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < count; i--) {
    const message = messages[i] as MessageLike;
    if (message.info.role !== "user") continue;
    const text = messageText(message).trim();
    if (text) texts.unshift(clip(text, 1_500));
  }
  return texts.join("\n---\n");
}
