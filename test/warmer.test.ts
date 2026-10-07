import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.js";
import type { RecordedRequest } from "../src/fetch.js";
import { ANTHROPIC_TTL_MS, Warmer } from "../src/warmer.js";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const opus = { input: 4, cacheRead: 0.2, cacheWrite: 5 };
const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };

function record(at: number, extra: Record<string, unknown> = {}): RecordedRequest {
  return {
    url: "https://api.anthropic.com/v1/messages?beta=true",
    headers: { authorization: "Bearer t" },
    body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 32000, stream: true, messages: [{ role: "user", content: "x" }], tools: [{ name: "bash" }], thinking: { type: "adaptive" }, ...extra }),
    sentAt: at,
    sessionID: "s",
  };
}

function response(promptTokens: number, cacheRead: number, status = 200) {
  return new Response(JSON.stringify({ usage: { input_tokens: promptTokens - cacheRead, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 1 }, error: { message: "nope" } }), { status });
}

function warmer(options: { replies?: Array<() => Response>; settings?: typeof DEFAULT_SETTINGS } = {}) {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const replies = options.replies ?? [];
  const log: string[] = [];
  const snapshots: Array<Record<string, unknown>> = [];
  const w = new Warmer({
    settings: () => options.settings ?? DEFAULT_SETTINGS,
    fetch: async (url, init) => {
      fetches.push({ url, init });
      const reply = replies.shift();
      return reply ? reply() : response(0, 0, 500);
    },
    log: (line) => log.push(line),
    onChange: (snapshot) => snapshots.push(snapshot as unknown as Record<string, unknown>),
  });
  return { w, fetches, log, snapshots };
}

describe("warmer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  test("replays at 90% of the TTL, counts a hit, and keeps going until the idle limit", async () => {
    const h = warmer({ replies: Array.from({ length: 10 }, () => () => response(600_000, 599_000)) });
    h.w.setModel("s", model, opus, ANTHROPIC_TTL_MS);
    h.w.recordRequest("s", record(T0));
    h.w.recordTokens("s", 601_000, model);
    h.w.setBusy("s", false);
    expect(h.w.get("s").warming).toBe(true);
    await vi.advanceTimersByTimeAsync(269_000);
    expect(h.fetches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fetches).toHaveLength(1);
    const sent = JSON.parse(h.fetches[0]!.init.body as string);
    expect(sent.max_tokens).toBe(1);
    expect(sent.stream).toBe(false);
    expect(h.w.get("s").warms).toBe(1);
    expect(h.w.get("s").lastAt).toBe(T0 + 270_000);
    expect(h.w.get("s").lastWarmCost).toBeCloseTo(0.12);
    // 30 minutes of idle allow six refreshes (270 s apart); the seventh would land past the limit.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.fetches).toHaveLength(6);
    expect(h.w.get("s").warming).toBe(false);
    expect(h.w.get("s").stopReason).toBe("30-minute idle limit reached");
  });

  test("a real request restarts the schedule and the count", async () => {
    const h = warmer({ replies: Array.from({ length: 3 }, () => () => response(600_000, 599_000)) });
    h.w.setModel("s", model, opus, ANTHROPIC_TTL_MS);
    h.w.recordRequest("s", record(T0));
    h.w.recordTokens("s", 601_000, model);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.w.get("s").warms).toBe(1);
    vi.setSystemTime(T0 + 300_000);
    h.w.recordRequest("s", record(T0 + 300_000));
    expect(h.w.get("s").warms).toBe(0);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(h.fetches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(h.fetches).toHaveLength(2);
    expect(h.fetches[1]!.url).toContain("/v1/messages");
  });

  test("stops when Pi's rule says the refresh is not worth it", async () => {
    const h = warmer();
    h.w.setModel("s", model, opus, ANTHROPIC_TTL_MS);
    h.w.recordRequest("s", record(T0));
    h.w.recordTokens("s", 50_000, model); // idle: 0.15 * 0.24 - 0.01 < 0.05
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.fetches).toHaveLength(0);
    expect(h.w.get("s").stopReason).toMatch(/expected saving/);
  });

  test("warms a small context while the agent is busy with a long tool call", async () => {
    const h = warmer({ replies: [() => response(50_000, 49_900)] });
    h.w.setModel("s", model, opus, ANTHROPIC_TTL_MS);
    h.w.recordRequest("s", record(T0));
    h.w.recordTokens("s", 50_000, model);
    h.w.setBusy("s", true);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(h.fetches).toHaveLength(1);
  });

  test("stops on a miss, an HTTP error, or an unreplayable request", async () => {
    const miss = warmer({ replies: [() => response(600_000, 1_000)] });
    miss.w.setModel("s", model, opus, ANTHROPIC_TTL_MS);
    miss.w.recordRequest("s", record(T0));
    miss.w.recordTokens("s", 601_000, model);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(miss.w.get("s").stopReason).toBe("refresh missed the cache");
    expect(miss.w.get("s").warms).toBe(0);
    expect(miss.log.some((line) => line.includes("missed"))).toBe(true);

    const error = warmer({ replies: [() => response(0, 0, 401)] });
    error.w.setModel("s", model, opus, ANTHROPIC_TTL_MS);
    error.w.recordRequest("s", record(T0));
    error.w.recordTokens("s", 601_000, model);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(error.w.get("s").stopReason).toBe("refresh failed (HTTP 401)");

    const budget = warmer();
    budget.w.setModel("s", model, opus, ANTHROPIC_TTL_MS);
    budget.w.recordRequest("s", record(T0, { thinking: { type: "enabled", budget_tokens: 4000 } }));
    budget.w.recordTokens("s", 601_000, model);
    await vi.advanceTimersByTimeAsync(270_000);
    expect(budget.fetches).toHaveLength(0);
    expect(budget.w.get("s").stopReason).toBe("request cannot be replayed (budget thinking)");
  });

  test("never warms subagent sessions, disabled settings, or a compacted context", async () => {
    const child = warmer();
    child.w.setChild("c", true);
    child.w.setModel("c", model, opus, ANTHROPIC_TTL_MS);
    child.w.recordRequest("c", record(T0));
    expect(child.w.get("c").warming).toBe(false);

    const off = warmer({ settings: mergeSettings(DEFAULT_SETTINGS, ['{"warm":{"enabled":false}}']) });
    off.w.setModel("s", model, opus, ANTHROPIC_TTL_MS);
    off.w.recordRequest("s", record(T0));
    expect(off.w.get("s").warming).toBe(false);
    expect(off.w.get("s").stopReason).toBe("warming disabled");

    const compacted = warmer();
    compacted.w.setModel("s", model, opus, ANTHROPIC_TTL_MS);
    compacted.w.recordRequest("s", record(T0));
    compacted.w.recordTokens("s", 601_000, model);
    compacted.w.reset("s");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(compacted.fetches).toHaveLength(0);
    expect(compacted.w.get("s").lastAt).toBe(0);
  });

  test("snapshots carry no request and track activity for providers without a wire record", () => {
    const h = warmer();
    h.w.setModel("o", { providerID: "openai", modelID: "gpt-6-astra" }, undefined, undefined);
    h.w.recordTokens("o", 120_000, { providerID: "openai", modelID: "gpt-6-astra" }, T0 - 5_000);
    const last = h.snapshots.at(-1)!;
    expect(last.lastAt).toBe(T0 - 5_000);
    expect(last.tokens).toBe(120_000);
    expect(last.ttlMs).toBeUndefined();
    expect("request" in last).toBe(false);
    expect("price" in last).toBe(false);
  });
});
