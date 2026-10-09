// opencode messages (`{ info, parts }`) for the tests.
import type { MessageLike } from "../src/units.js";

export const user = (text: string, synthetic = false): MessageLike => ({ info: { role: "user" }, parts: [{ type: "text", text, synthetic }] });

export const assistant = (
  texts: string[],
  tools: Array<{ tool: string; callID: string; input: Record<string, unknown>; output?: string; error?: string }> = [],
  summary?: boolean,
): MessageLike => ({
  info: { role: "assistant", ...(summary ? { summary: true } : {}) },
  parts: [
    { type: "step-start" },
    ...texts.map((text) => ({ type: "text", text })),
    ...tools.map((t) => ({
      type: "tool",
      tool: t.tool,
      callID: t.callID,
      state: t.error !== undefined
        ? { status: "error", input: t.input, error: t.error, time: { start: 1, end: 2 } }
        : { status: "completed", input: t.input, output: t.output ?? "", title: t.tool, metadata: {}, time: { start: 1, end: 2 } },
    })),
    { type: "step-finish" },
  ],
});
