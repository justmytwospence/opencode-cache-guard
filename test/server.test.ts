import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SESSION_HEADER, uninstall } from "../src/fetch.js";
import { VERBATIM_LEAD } from "../src/compact.js";
import { CacheGuardPlugin, coldReason, createServer, priceOf, promptText } from "../src/server.js";
import { DEFAULT_SETTINGS } from "../src/core.js";
import { writeConfirm, writeGuidance } from "../src/holds.js";
import { view } from "../src/status.js";
import { assistant as assistantMessage, user } from "./messages.js";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const URL_ = "https://api.anthropic.com/v1/messages?beta=true";
const sonnet = { id: "claude-sonnet-5-5", providerID: "anthropic", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } };
const opus = { id: "claude-opus-5-5", providerID: "anthropic", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } };

function assistant(sessionID: string, created: number, prompt: number, modelID = "claude-sonnet-5-5") {
  return { id: "msg", sessionID, role: "assistant", providerID: "anthropic", modelID, time: { created, completed: created + 5_000 }, tokens: { input: 2, output: 1_000, reasoning: 0, cache: { read: prompt - 2, write: 0 } } };
}

let dir: string;
let cache: string;

function fakeClient(messages: unknown[] = []) {
  return {
    tui: { showToast: vi.fn(async () => ({ data: true })), appendPrompt: vi.fn(async () => ({ data: true })), publish: vi.fn(async () => ({ data: true })) },
    session: { messages: vi.fn(async () => ({ data: messages })) },
    app: { log: vi.fn(async () => ({ data: true })) },
  };
}

async function plugin(messages: unknown[] = []) {
  const client = fakeClient(messages);
  const hooks = await CacheGuardPlugin({ client, directory: dir } as any);
  return { hooks, client };
}

/** The plugin with Jev answering through a fake fetch (the API's shapes), and a key in the environment. */
async function withJev(messages: unknown[], answer: (questions: Record<string, any>, state: any) => unknown, options?: Record<string, unknown>, key = "k") {
  const client = fakeClient(messages);
  const sent: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    const answers = answer(body.questions, body.state);
    if (answers instanceof Response) return answers;
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10 } }));
  }) as unknown as typeof fetch;
  const env = { ...process.env, TYPESAFE_API_KEY: key, XDG_DATA_HOME: path.join(cache, "data") };
  const hooks = await createServer({ client: client as any, directory: dir }, options, { fetch: fetchImpl, env });
  return { hooks, client, sent };
}

const big = Array.from({ length: 2_000 }, (_, i) => (i === 1_000 ? "Error: expected 3 retries, got 1" : `ok ${i} ${"-".repeat(10)}`)).join("\n");
const keepErrors = (questions: Record<string, any>, state: any) =>
  Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: id.startsWith("block::") && String(state?.output?.[id.slice(7)] ?? "").includes("Error") ? 0.9 : 0.05 }]));
const keepFirstVerbatim = (questions: Record<string, any>) =>
  Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "choice", choice: id === "keep::U001" ? "verbatim" : "summarize", probabilities: {}, confidence: 1 }]));

const prompt = (text: string) => ({ message: { id: "u" } as any, parts: [{ type: "text", text, id: "p", sessionID: "s", messageID: "u" }] as any });

describe("server", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = mkdtempSync(path.join(tmpdir(), "cg-dir-"));
    cache = mkdtempSync(path.join(tmpdir(), "cg-cache-"));
    process.env.XDG_CACHE_HOME = cache;
    process.env.XDG_CONFIG_HOME = path.join(cache, "no-config");
  });
  afterEach(() => {
    uninstall();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  test("names the session on the wire, records the request, and leaves a state file", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls.push(init!);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const { hooks } = await plugin();
    const headers = { headers: {} as Record<string, string> };
    await hooks["chat.params"]!({ sessionID: "s", agent: "build", model: sonnet, provider: {}, message: {} } as any, {} as any);
    await hooks["chat.headers"]!({ sessionID: "s", agent: "build", model: sonnet, provider: {}, message: {} } as any, headers);
    expect(headers.headers[SESSION_HEADER]).toBe("s");
    await globalThis.fetch(URL_, { method: "POST", headers: headers.headers, body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [], tools: [{ name: "bash" }] }) });
    expect(new Headers(calls[0]!.headers).has(SESSION_HEADER)).toBe(false);
    await hooks.event!({ event: { type: "message.updated", properties: { info: assistant("s", T0, 200_000) } } as any });
    await vi.advanceTimersByTimeAsync(10);
    const snapshot = JSON.parse(readFileSync(path.join(cache, "opencode-cache-guard", "s.json"), "utf8"));
    expect(snapshot).toMatchObject({ sessionID: "s", lastAt: T0, lastRealAt: T0, ttlMs: 300_000, tokens: 201_000, model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, warming: true, warms: 0 });
    expect(snapshot.request).toBeUndefined();
    expect(view(snapshot, T0 + 48_000, DEFAULT_SETTINGS)).toEqual({ left: "4:12", warms: 0 });
    expect(view(snapshot, T0 + 300_001, DEFAULT_SETTINGS)).toEqual({ cold: "cold", warms: 0 });
    await hooks.dispose!();
  });

  test("holds a cold prompt once, puts the text back, and lets the same prompt through next time", async () => {
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const { hooks, client } = await plugin();
    await hooks["chat.params"]!({ sessionID: "s", agent: "build", model: sonnet, provider: {}, message: {} } as any, {} as any);
    await globalThis.fetch(URL_, { method: "POST", headers: { [SESSION_HEADER]: "s" }, body: JSON.stringify({ messages: [], tools: [{ name: "bash" }] }) });
    await hooks.event!({ event: { type: "message.updated", properties: { info: assistant("s", T0, 600_000) } } as any });
    vi.setSystemTime(T0 + 60_000);
    await expect(hooks["chat.message"]!({ sessionID: "s", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, prompt("go on"))).resolves.toBeUndefined();
    vi.setSystemTime(T0 + 15 * 60_000);
    await expect(hooks["chat.message"]!({ sessionID: "s", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, prompt("go on"))).rejects.toThrow(/held this prompt/);
    expect(client.tui.showToast).not.toHaveBeenCalled(); // after the TUI's own error toast
    await vi.advanceTimersByTimeAsync(500);
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    const toast = (client.tui.showToast.mock.calls[0] as any)[0].body;
    expect(toast.title).toBe("Prompt cache miss");
    expect(toast.message).toContain("The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$1.38 at API prices).");
    expect(client.tui.appendPrompt).toHaveBeenCalledWith({ body: { text: "go on" } });
    expect(client.tui.publish).toHaveBeenCalledWith({ body: { type: "tui.command.execute", properties: { command: "cache-guard.held" } } });
    // The hold is in the state file for the TUI, with the ways through it priced.
    const held = JSON.parse(readFileSync(path.join(cache, "opencode-cache-guard", "s.json"), "utf8")).held;
    expect(held).toMatchObject({ text: "go on", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, tokens: 601_000, reason: "expired", seq: T0 + 15 * 60_000 });
    expect(held.costs.send).toBeCloseTo(1.5025, 3);
    expect(held.costs.compact).toBeCloseTo(1.202, 3);
    vi.setSystemTime(T0 + 16 * 60_000);
    await expect(hooks["chat.message"]!({ sessionID: "s", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, prompt("go on "))).resolves.toBeUndefined();
    // The hold cleared with the send.
    expect(JSON.parse(readFileSync(path.join(cache, "opencode-cache-guard", "s.json"), "utf8")).held).toBeUndefined();
    // A different prompt is held again.
    await expect(hooks["chat.message"]!({ sessionID: "s", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, prompt("something else"))).rejects.toThrow();
    await hooks.dispose!();
  });

  test("the TUI's choice authorises one send through a confirm file; mute stops the holds", async () => {
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const { hooks } = await plugin();
    await hooks["chat.params"]!({ sessionID: "s", agent: "build", model: sonnet, provider: {}, message: {} } as any, {} as any);
    await globalThis.fetch(URL_, { method: "POST", headers: { [SESSION_HEADER]: "s" }, body: JSON.stringify({ messages: [], tools: [{ name: "bash" }] }) });
    await hooks.event!({ event: { type: "message.updated", properties: { info: assistant("s", T0, 600_000) } } as any });
    vi.setSystemTime(T0 + 15 * 60_000);
    const state = path.join(cache, "opencode-cache-guard");
    const message = { sessionID: "s", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } };
    // A confirm for another text does not count, and is consumed.
    writeConfirm(state, "s", "other");
    await expect(hooks["chat.message"]!(message, prompt("go on"))).rejects.toThrow(/held/);
    expect(existsSync(path.join(state, "s.confirm.json"))).toBe(false);
    // The dialog's "Send anyway": the text is authorised once.
    writeConfirm(state, "s", "go on");
    await expect(hooks["chat.message"]!(message, prompt("go on"))).resolves.toBeUndefined();
    expect(existsSync(path.join(state, "s.confirm.json"))).toBe(false);
    await expect(hooks["chat.message"]!(message, prompt("again"))).rejects.toThrow(/held/);
    // "Send, and stop asking in this session".
    writeConfirm(state, "s", "again", true);
    await expect(hooks["chat.message"]!(message, prompt("again"))).resolves.toBeUndefined();
    await expect(hooks["chat.message"]!(message, prompt("and again"))).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(state, "s.json"), "utf8")).muted).toBe(true);
    await hooks.dispose!();
  });

  test("compaction guidance left by the TUI reaches the compacting hook once", async () => {
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const { hooks } = await plugin();
    const state = path.join(cache, "opencode-cache-guard");
    writeGuidance(state, "s", "Keep the plan.");
    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await hooks["experimental.session.compacting"]!({ sessionID: "s" }, output);
    expect(output.context).toEqual(["Keep the plan."]);
    const again = { context: [] as string[], prompt: undefined as string | undefined };
    await hooks["experimental.session.compacting"]!({ sessionID: "s" }, again);
    expect(again.context).toEqual([]);
    // Stale guidance (over an hour old) is dropped.
    writeGuidance(state, "t", "old");
    vi.setSystemTime(T0 + 2 * 3_600_000);
    await hooks["experimental.session.compacting"]!({ sessionID: "t" }, again);
    expect(again.context).toEqual([]);
    await hooks.dispose!();
  });

  test("with Jev, large tool output is trimmed in tool.execute.after, logged under cache-guard, and toasted", async () => {
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const history = [user("Fix the retry test"), assistantMessage(["Running the tests."])];
    const { hooks, client, sent } = await withJev(history, keepErrors);
    const output = { title: "npm test", output: big, metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c1", args: { command: "npm test" } }, output);
    expect(output.output).toContain("Error: expected 3 retries, got 1");
    expect(output.output.length).toBeLessThan(big.length / 5);
    expect(output.output).toContain("/opencode/cache-guard/tool-output/s/c1.txt");
    expect(sent[0].state.intent).toMatchObject({ user_request: "Fix the retry test", agent_said: "Running the tests." });
    expect(client.app.log).toHaveBeenCalledWith({ body: { service: "cache-guard", level: "info", message: expect.stringMatching(/^bash: kept \d+ of 2000 lines/u) } });
    expect(client.tui.showToast).toHaveBeenCalledWith({ body: { title: "cache-guard", message: expect.stringMatching(/^bash output trimmed to \d+ of 2000 lines$/u), variant: "info" } });
    expect(readFileSync(path.join(cache, "opencode-cache-guard", "log.txt"), "utf8")).toMatch(/trim bash: kept/u);
    // The same call again this turn is left whole; a new prompt starts a new turn (even one that is held).
    const again = { title: "npm test", output: big, metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c2", args: { command: "npm test" } }, again);
    expect(again.output).toBe(big);
    await hooks["chat.message"]!({ sessionID: "s" }, prompt("next"));
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c3", args: { command: "npm test" } }, again);
    expect(again.output).not.toBe(big);
    expect(sent).toHaveLength(2);
    // Without a key nothing is asked.
    const noKey = await withJev(history, keepErrors, undefined, "");
    const whole = { title: "npm test", output: big, metadata: {} };
    await noKey.hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c1", args: {} }, whole);
    expect(whole.output).toBe(big);
    expect(noKey.sent).toEqual([]);
    // Plugin options from opencode.jsonc are a settings layer.
    const off = await withJev(history, keepErrors, { trim: { enabled: false } });
    await off.hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c1", args: {} }, whole);
    expect(whole.output).toBe(big);
    expect(off.sent).toEqual([]);
    await hooks.dispose!();
  });

  test("with Jev, the compacting hook adds the verbatim items after the guidance; failures add nothing", async () => {
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const history = [user("Use pnpm, never npm."), assistantMessage(["Exploring."]), user("Now add a cache.")];
    const { hooks, sent } = await withJev(history, keepFirstVerbatim);
    const state = path.join(cache, "opencode-cache-guard");
    writeGuidance(state, "s", "Keep the plan.");
    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await hooks["experimental.session.compacting"]!({ sessionID: "s" }, output);
    expect(output.context).toEqual(["Keep the plan.", `${VERBATIM_LEAD}\n\n## Kept verbatim\n\n**User:** Use pnpm, never npm.`]);
    expect(sent[0].state.current_goal).toBe("Keep the plan.");
    expect(sent[0].questions["keep::U001"].type).toBe("choice");
    // No guidance: the goal is the last two requests.
    const plain = { context: [] as string[], prompt: undefined as string | undefined };
    await hooks["experimental.session.compacting"]!({ sessionID: "s" }, plain);
    expect(sent[1].state.current_goal).toBe("Use pnpm, never npm.\n---\nNow add a cache.");
    expect(plain.context).toHaveLength(1);
    // Jev down, filter off, or no key: only the guidance.
    const down = await withJev(history, () => new Response("x", { status: 503 }));
    const none = { context: [] as string[], prompt: undefined as string | undefined };
    await down.hooks["experimental.session.compacting"]!({ sessionID: "s" }, none);
    expect(none.context).toEqual([]);
    const unfiltered = await withJev(history, keepFirstVerbatim, { compact: { filter: false } });
    await unfiltered.hooks["experimental.session.compacting"]!({ sessionID: "s" }, none);
    expect(none.context).toEqual([]);
    expect(unfiltered.sent).toEqual([]);
    const noKey = await withJev(history, keepFirstVerbatim, undefined, "");
    await noKey.hooks["experimental.session.compacting"]!({ sessionID: "s" }, none);
    expect(none.context).toEqual([]);
    await hooks.dispose!();
  });

  test("small contexts and synthetic-only prompts pass; a model switch is held", async () => {
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const { hooks } = await plugin();
    await hooks["chat.params"]!({ sessionID: "s", agent: "build", model: sonnet, provider: {}, message: {} } as any, {} as any);
    await globalThis.fetch(URL_, { method: "POST", headers: { [SESSION_HEADER]: "s" }, body: JSON.stringify({ messages: [], tools: [{ name: "bash" }] }) });
    await hooks.event!({ event: { type: "message.updated", properties: { info: assistant("s", T0, 20_000) } } as any });
    vi.setSystemTime(T0 + 15 * 60_000);
    await expect(hooks["chat.message"]!({ sessionID: "s", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, prompt("hi"))).resolves.toBeUndefined();
    await hooks.event!({ event: { type: "message.updated", properties: { info: assistant("s", T0 + 15 * 60_000, 600_000) } } as any });
    vi.setSystemTime(T0 + 15 * 60_000 + 1_000);
    await expect(hooks["chat.message"]!({ sessionID: "s", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, { message: {} as any, parts: [{ type: "text", text: "attached", synthetic: true }] as any })).resolves.toBeUndefined();
    await expect(hooks["chat.message"]!({ sessionID: "s", model: { providerID: "anthropic", modelID: "claude-opus-5-5" } }, prompt("switch"))).rejects.toThrow(/held/);
    await hooks.dispose!();
  });

  test("a resumed session's clock comes from its last reply", async () => {
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const { hooks, client } = await plugin([{ info: { role: "user" }, parts: [] }, { info: assistant("r", T0 - 3_600_000, 700_000), parts: [] }]);
    await expect(hooks["chat.message"]!({ sessionID: "r", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, prompt("back"))).rejects.toThrow(/held/);
    expect(client.session.messages).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    const toast = (client.tui.showToast.mock.calls[0] as any)[0].body;
    expect(toast.message).toContain("expired 54m");
    await hooks.dispose!();
  });

  test("warnings follow the settings files", async () => {
    globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    mkdirSync(path.join(dir, ".opencode"));
    writeFileSync(path.join(dir, ".opencode", "cache-guard.json"), JSON.stringify({ warn: { enabled: false } }));
    const { hooks, client } = await plugin([{ info: assistant("r", T0 - 3_600_000, 700_000), parts: [] }]);
    await expect(hooks["chat.message"]!({ sessionID: "r", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, prompt("back"))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(client.tui.showToast).not.toHaveBeenCalled();
    await hooks.dispose!();
  });
});

describe("helpers", () => {
  test("prices: catalog when priced, list prices for an OAuth-zeroed Claude model, none otherwise", () => {
    expect(priceOf({ providerID: "anthropic", modelID: "claude-opus-5-5" }, { input: 15, cache: { read: 1.5, write: 18.75 } })).toEqual({ input: 15, cacheRead: 1.5, cacheWrite: 18.75 });
    expect(priceOf({ providerID: "anthropic", modelID: "claude-opus-5-5" }, opus.cost)).toEqual({ input: 4, cacheRead: 0.2 });
    expect(priceOf({ providerID: "openai", modelID: "gpt-6-astra" }, { input: 0 })).toBeUndefined();
  });

  test("cold reasons", () => {
    const s = DEFAULT_SETTINGS;
    const anthropic = { lastAt: T0, ttlMs: 300_000, model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } };
    expect(coldReason(anthropic, anthropic.model, T0 + 100_000, s)).toBeUndefined();
    expect(coldReason(anthropic, anthropic.model, T0 + 400_000, s)).toEqual({ kind: "expired", idleMs: 100_000 });
    expect(coldReason(anthropic, { providerID: "anthropic", modelID: "claude-opus-5-5" }, T0 + 1, s)).toEqual({ kind: "model", from: "claude-sonnet-5-5", to: "claude-opus-5-5" });
    const openai = { lastAt: T0, ttlMs: undefined, model: { providerID: "openai", modelID: "gpt-6-astra" } };
    expect(coldReason(openai, openai.model, T0 + 2 * 3_600_000, s)).toBeUndefined();
    expect(coldReason(openai, openai.model, T0 + 4 * 3_600_000, s)).toEqual({ kind: "idle", idleMs: 4 * 3_600_000 });
    expect(coldReason({ lastAt: 0, ttlMs: 300_000, model: undefined }, undefined, T0, s)).toBeUndefined();
  });

  test("prompt text skips what opencode attached", () => {
    expect(promptText([{ type: "text", text: "  real  " }, { type: "text", text: "ctx", synthetic: true }, { type: "file" }])).toBe("real");
  });
});
