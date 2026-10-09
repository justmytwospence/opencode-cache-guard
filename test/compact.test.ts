import { expect, test } from "vitest";

import { VERBATIM_LEAD, jevSummary, judgeUnits, verbatimContext } from "../src/compact.js";
import { DEFAULT_SETTINGS } from "../src/core.js";
import type { Ask, JevOutcome } from "../src/jev.js";
import type { Answer, Unit } from "../src/lean.js";
import { assistant, user } from "./messages.js";

const COMPACT = DEFAULT_SETTINGS.compact;

/** Jev that keeps U001 verbatim, drops U002 and summarizes the rest; records each request. */
function asking(verdict: (id: string) => "verbatim" | "summarize" | "drop", fail?: (call: number) => string | undefined) {
  const calls: Array<{ state: any; ids: string[] }> = [];
  let inFlight = 0;
  let peak = 0;
  const ask: Ask = async (state, questions) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    const ids = Object.keys(questions);
    calls.push({ state, ids });
    const reason = fail?.(calls.length);
    if (reason) return { ok: false, reason };
    const answers: Record<string, Answer> = Object.fromEntries(ids.map((id) => [id, { type: "choice", choice: verdict(id.slice(6)), probabilities: {}, confidence: 1 }]));
    return { ok: true, answers, model: "jev-test", latencyMs: 5, inputTokens: 100 } satisfies JevOutcome;
  };
  return { ask, calls, peak: () => peak };
}

const unit = (i: number, kind: Unit["kind"] = "assistant"): Unit => ({ id: `U${String(i).padStart(3, "0")}`, kind, text: `text ${i}`, message: i });

test("judgeUnits batches the units, runs batches concurrently, and sums the tokens", async () => {
  const units = Array.from({ length: 250 }, (_, i) => unit(i + 1));
  const jev = asking((id) => (id === "U001" ? "verbatim" : id === "U002" ? "drop" : "summarize"));
  const judged = await judgeUnits(units, "the goal", { ...COMPACT, concurrency: 2 }, jev.ask);
  expect(judged.ok).toBe(true);
  if (!judged.ok) return;
  expect(jev.calls).toHaveLength(3);
  expect(jev.peak()).toBe(2);
  expect(jev.calls[0]!.state.current_goal).toBe("the goal");
  expect(judged.counts).toEqual({ verbatim: 1, drop: 1, summarize: 248 });
  expect(judged.keep.get("U001")).toBe("verbatim");
  expect(judged.inputTokens).toBe(300);
  // A failed batch fails the pass, and stops the queue.
  const down = asking(() => "summarize", (call) => (call === 1 ? "HTTP 500" : undefined));
  expect(await judgeUnits(units, "g", { ...COMPACT, concurrency: 1 }, down.ask)).toEqual({ ok: false, reason: "Jev failed (HTTP 500)" });
  expect(down.calls).toHaveLength(1);
});

const history = [
  user("Use pnpm, never npm."),
  assistant(["Exploring."], [{ tool: "bash", callID: "c1", input: { command: "ls" }, output: "a\nb" }]),
  user("Now add a cache."),
  assistant([], [{ tool: "edit", callID: "c2", input: { filePath: "src/cache.ts" }, output: "ok" }]),
];

test("jevSummary writes the summary in code, judged against the held prompt", async () => {
  const jev = asking((id) => (id === "U001" ? "verbatim" : id === "U002" ? "drop" : "summarize"));
  const result = await jevSummary(history, "fix the parser", COMPACT, jev.ask);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(jev.calls[0]!.state.current_goal).toBe("fix the parser");
  expect(jev.calls[0]!.state.units.U003).toEqual({ kind: "tool", call: 'bash({"command":"ls"})', result: "a\nb" });
  expect(result.summary).toMatch(/^# Compacted with Jev/u);
  expect(result.summary).toContain("## Kept verbatim\n\n**User:** Use pnpm, never npm.");
  expect(result.summary).not.toContain("Exploring.");
  expect(result.summary).toContain("- Use pnpm, never npm.\n- Now add a cache.");
  expect(result.summary).toContain("Modified: src/cache.ts");
  expect(result.counts).toEqual({ verbatim: 1, drop: 1, summarize: 3 });
  expect(result.units).toBe(5);
  expect(await jevSummary([], "g", COMPACT, jev.ask)).toEqual({ ok: false, reason: "nothing for Jev to judge" });
  const down = asking(() => "summarize", () => "timed out");
  expect(await jevSummary(history, "g", COMPACT, down.ask)).toEqual({ ok: false, reason: "Jev failed (timed out)" });
});

test("verbatimContext: the lead sentence and the verbatim section, judged against the guidance or the last two requests", async () => {
  const jev = asking((id) => (id === "U001" ? "verbatim" : "summarize"));
  const withGuidance = await verbatimContext(history, "Keep the plan.", COMPACT, jev.ask);
  expect(withGuidance.ok && withGuidance.context).toBe(`${VERBATIM_LEAD}\n\n## Kept verbatim\n\n**User:** Use pnpm, never npm.`);
  expect(jev.calls[0]!.state.current_goal).toBe("Keep the plan.");
  await verbatimContext(history, undefined, COMPACT, jev.ask);
  expect(jev.calls[1]!.state.current_goal).toBe("Use pnpm, never npm.\n---\nNow add a cache.");
  // Nothing verbatim: an empty context, still ok.
  const none = asking(() => "summarize");
  const empty = await verbatimContext(history, "", COMPACT, none.ask);
  expect(empty).toMatchObject({ ok: true, context: "", counts: { verbatim: 0 } });
  const down = asking(() => "summarize", () => "HTTP 503");
  expect(await verbatimContext(history, "", COMPACT, down.ask)).toEqual({ ok: false, reason: "Jev failed (HTTP 503)" });
  expect(await verbatimContext([], "", COMPACT, jev.ask)).toEqual({ ok: false, reason: "nothing for Jev to judge" });
});
