import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { DEFAULT_SETTINGS, type Settings, mergeSettings } from "../src/core.js";
import { askJev } from "../src/jev.js";
import { type Trimmer, createTrimmer, savePath, toastWanted, trimFloor, untruncated } from "../src/trim.js";
import { assistant, user } from "./messages.js";

const TRIM = DEFAULT_SETTINGS.trim;
const data = mkdtempSync(path.join(tmpdir(), "cg-data-"));
const env = { XDG_DATA_HOME: data, TYPESAFE_API_KEY: "k" };
afterAll(() => rmSync(data, { recursive: true, force: true }));

const big = Array.from({ length: 2_000 }, (_, i) => (i === 1_000 ? "Error: expected 3 retries, got 1" : `ok ${i} ${"-".repeat(10)}`)).join("\n");

type Answerer = (questions: Record<string, any>, state: any) => unknown;

/** Jev answers (as the API sends them) that keep the blocks mentioning an error. */
const keepErrors: Answerer = (questions, state) =>
  Object.fromEntries(
    Object.keys(questions).map((id) => {
      const block = id.startsWith("block::") ? String(state?.output?.[id.slice(7)] ?? "") : "";
      return [id, { type: "noul", noul: block.includes("Error") ? 0.9 : 0.05 }];
    }),
  );

const history = [user("Fix the retry test"), assistant(["Running the tests."], [{ tool: "bash", callID: "c0", input: { command: "npm test" }, output: "" }])];

function setup(answer: Answerer, settings: Settings | (() => Settings) = DEFAULT_SETTINGS, key = "k") {
  const sent: any[] = [];
  const logs: string[] = [];
  const toasts: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    const answers = answer(body.questions, body.state);
    if (answers instanceof Response) return answers;
    if (answers instanceof Error) throw answers;
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 300 } }));
  }) as unknown as typeof fetch;
  const settingsNow = typeof settings === "function" ? settings : () => settings;
  const trimmer = createTrimmer({
    settings: settingsNow,
    messages: async () => history,
    ask: (s) => (state, questions) => askJev(state, questions, { model: s.jev.model, timeoutMs: s.jev.timeoutMs, apiKey: key, fetch: fetchImpl }),
    log: (line) => logs.push(line),
    toast: (message) => toasts.push(message),
    env: { ...env, TYPESAFE_API_KEY: key },
  });
  return { trimmer, sent, logs, toasts };
}

async function run(trimmer: Trimmer, text = big, call: { tool?: string; callID?: string; args?: unknown } = {}) {
  const output = { title: "npm test", output: text, metadata: {} };
  await trimmer.afterTool({ tool: call.tool ?? "bash", sessionID: "ses_1", callID: call.callID ?? "call_1", args: call.args ?? { command: "npm test" } }, output);
  return output.output;
}

test("large output is trimmed to the needed blocks and saved in full", async () => {
  const s = setup(keepErrors);
  const text = await run(s.trimmer);
  expect(text).toContain("Error: expected 3 retries, got 1");
  expect(text).toMatch(/\[… \d+ lines omitted …\]/u);
  expect(text.length).toBeLessThan(big.length / 5);
  expect(text).toMatch(/\[Trimmed by Jev: kept \d+ of 2000 lines that matter for this step\. Full output: /u);
  const full = /Full output: (\S+)/u.exec(text)?.[1] as string;
  expect(full).toBe(savePath("ses_1", "call_1", env));
  expect(full).toMatch(/\/opencode\/cache-guard\/tool-output\/ses_1\/call_1\.txt$/u);
  expect(readFileSync(full, "utf8")).toBe(big);
  expect(s.sent[0].state.intent).toMatchObject({ user_request: "Fix the retry test", agent_said: "Running the tests.", tool: "bash", arguments: '{"command":"npm test"}' });
  expect(s.sent[0].questions.needs_all.type).toBe("noul");
  expect(s.sent[0].model).toBe("jev-latest");
  expect(s.logs[0]).toMatch(/^bash: kept \d+ of 2000 lines, about \d+k tokens saved \(needs_all 0\.05, \d+ blocks, \d+ ms, 300 tokens\); full output /u);
  expect(s.toasts).toEqual([expect.stringMatching(/^bash output trimmed to \d+ of 2000 lines$/u)]);
  expect(s.trimmer.savedChars()).toBe(big.length - text.length);

  // Asking for the same thing again in the same turn returns it in full; a new turn trims again.
  expect(await run(s.trimmer, big, { callID: "call_2" })).toBe(big);
  expect(s.sent).toHaveLength(1);
  s.trimmer.newTurn("ses_1");
  expect(await run(s.trimmer, big, { callID: "call_3" })).not.toBe(big);
  expect(s.sent).toHaveLength(2);
});

test("no trim when the agent needs it all or most would be kept", async () => {
  const needsAll = setup((q, st) => ({ ...(keepErrors(q, st) as object), needs_all: { type: "noul", noul: 0.9 } }));
  expect(await run(needsAll.trimmer)).toBe(big);
  expect(needsAll.logs[0]).toMatch(/^bash: left whole, \d+ of 2000 lines needed \(needs_all 0\.90/u);
  const most = setup((q) => Object.fromEntries(Object.keys(q).map((id) => [id, { type: "noul", noul: id === "needs_all" ? 0 : 0.8 }])));
  expect(await run(most.trimmer)).toBe(big);
  expect(most.toasts).toEqual([]);
});

test("Jev failures and a missing key leave the output untouched", async () => {
  const down = setup(() => new Response("boom", { status: 500 }));
  expect(await run(down.trimmer)).toBe(big);
  expect(down.logs).toEqual(["bash: left whole, Jev unavailable (HTTP 500)"]);
  const thrown = setup(() => new Error("socket hang up"));
  expect(await run(thrown.trimmer)).toBe(big);
  expect(thrown.logs[0]).toContain("socket hang up");
  const noKey = setup(keepErrors, DEFAULT_SETTINGS, "");
  expect(await run(noKey.trimmer)).toBe(big);
  expect(noKey.sent).toEqual([]);
  expect(noKey.logs).toEqual([]);
});

test("small output, whole-output tools and the settings' switches pass through without Jev", async () => {
  const s = setup(keepErrors);
  expect(await run(s.trimmer, "ok")).toBe("ok");
  expect(await run(s.trimmer, big, { tool: "edit" })).toBe(big);
  expect(await run(s.trimmer, big, { tool: "task" })).toBe(big);
  expect(await run(s.trimmer, big.slice(0, 40_000), { tool: "read" })).toBe(big.slice(0, 40_000));
  expect(s.sent).toEqual([]);
  for (const text of ['{"enabled":false}', '{"trim":{"enabled":false}}', '{"jev":{"enabled":false}}', '{"jev":{"provider":"openrouter"}}']) {
    const off = setup(keepErrors, mergeSettings(DEFAULT_SETTINGS, [text]));
    expect(await run(off.trimmer)).toBe(big);
    expect(off.sent).toEqual([]);
  }
  // Settings are read on each call, so edits apply without a restart; trim.toast is this port's.
  let current = mergeSettings(DEFAULT_SETTINGS, ['{"trim":{"enabled":false}}']);
  const live = setup(keepErrors, () => current);
  expect(await run(live.trimmer)).toBe(big);
  current = mergeSettings(DEFAULT_SETTINGS, ['{"trim":{"toast":false}}']);
  expect(toastWanted(current)).toBe(false);
  expect(await run(live.trimmer, big, { callID: "call_live" })).not.toBe(big);
  expect(live.toasts).toEqual([]);
});

test("when opencode truncated the output, Jev picks from the full output it saved", async () => {
  const dir = path.join(data, "opencode", "tool-output");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "tool_1");
  writeFileSync(file, big);
  // opencode's preview: the last lines only, which do not include the error at line 1000.
  const tail = big.split("\n").slice(-900).join("\n");
  const preview = `...1100 lines truncated...\n\nThe tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content.\n\n${tail}`;
  const s = setup(keepErrors);
  const text = await run(s.trimmer, preview);
  expect(text).toContain("Error: expected 3 retries, got 1");
  expect(text.length).toBeLessThan(preview.length);
  expect(readFileSync(savePath("ses_1", "call_1", env), "utf8")).toBe(big);

  // A path outside opencode's tool-output directory is never read.
  expect(untruncated("Full output saved to: /etc/passwd", dir)).toBeUndefined();
  expect(untruncated(`Full output saved to: ${file}`, dir)).toBe(big);
  expect(untruncated("no hint", dir)).toBeUndefined();
  // When the trim of the full output is no smaller than the preview, the preview stays.
  const keepMost = setup((q) => Object.fromEntries(Object.keys(q).map((id) => [id, { type: "noul", noul: id === "needs_all" ? 0 : Number(id.slice(8)) <= 90 ? 0.9 : 0.1 }])));
  expect(await run(keepMost.trimmer, preview, { callID: "call_preview" })).toBe(preview);
  expect(keepMost.logs[0]).toMatch(/^bash: left opencode's preview, the trim of the full output is no smaller/u);
});

test("trimFloor: which tools are trimmed and from what size", () => {
  expect(trimFloor("bash", TRIM)).toBe(12_000);
  expect(trimFloor("grep", TRIM)).toBe(12_000);
  expect(trimFloor("glob", TRIM)).toBe(12_000);
  expect(trimFloor("list", TRIM)).toBe(12_000);
  expect(trimFloor("webfetch", TRIM)).toBe(12_000);
  expect(trimFloor("websearch", TRIM)).toBe(12_000);
  expect(trimFloor("context7_query-docs", TRIM)).toBe(12_000);
  expect(trimFloor("read", TRIM)).toBe(50_000);
  expect(trimFloor("edit", TRIM)).toBeUndefined();
  expect(trimFloor("write", TRIM)).toBeUndefined();
  expect(trimFloor("apply_patch", TRIM)).toBeUndefined();
  expect(trimFloor("task", TRIM)).toBeUndefined();
  expect(trimFloor("todowrite", TRIM)).toBeUndefined();
  expect(trimFloor("skill", TRIM)).toBeUndefined();
});

test("savePath keeps ids safe for the file system", () => {
  expect(savePath("ses/1", "call:2", env)).toBe(path.join(data, "opencode", "cache-guard", "tool-output", "ses_1", "call_2.txt"));
});
