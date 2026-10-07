import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SESSION_HEADER, uninstall } from "../src/fetch.js";
import { CacheGuardPlugin, coldReason, priceOf, promptText } from "../src/server.js";
import { DEFAULT_SETTINGS } from "../src/core.js";
import { view } from "../src/status.js";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const URL_ = "https://api.anthropic.com/v1/messages?beta=true";
const sonnet = { id: "claude-sonnet-5-5", providerID: "anthropic", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } };
const opus = { id: "claude-opus-5-5", providerID: "anthropic", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } };

function assistant(sessionID: string, created: number, prompt: number, modelID = "claude-sonnet-5-5") {
  return { id: "msg", sessionID, role: "assistant", providerID: "anthropic", modelID, time: { created, completed: created + 5_000 }, tokens: { input: 2, output: 1_000, reasoning: 0, cache: { read: prompt - 2, write: 0 } } };
}

let dir: string;
let cache: string;

async function plugin(messages: unknown[] = []) {
  const client = {
    tui: { showToast: vi.fn(async () => ({ data: true })), appendPrompt: vi.fn(async () => ({ data: true })) },
    session: { messages: vi.fn(async () => ({ data: messages })) },
  };
  const hooks = await CacheGuardPlugin({ client, directory: dir } as any);
  return { hooks, client };
}

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
    vi.setSystemTime(T0 + 16 * 60_000);
    await expect(hooks["chat.message"]!({ sessionID: "s", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, prompt("go on "))).resolves.toBeUndefined();
    // A different prompt is held again.
    await expect(hooks["chat.message"]!({ sessionID: "s", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, prompt("something else"))).rejects.toThrow();
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
