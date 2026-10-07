import { afterEach, describe, expect, test } from "vitest";

import { SESSION_HEADER, inspect, install, isAnthropicMessages, parseUsage, replayRequest, uninstall } from "../src/fetch.js";

const URL_ = "https://api.anthropic.com/v1/messages?beta=true";
const body = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 32000, stream: true, system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }], tools: [{ name: "bash" }], ...extra });

describe("inspect", () => {
  test("records an Anthropic request with tools, named by the session header, and strips the header", async () => {
    const init = { method: "POST", headers: { authorization: "Bearer t", [SESSION_HEADER]: "ses_1", "x-session-id": "ses_1" }, body: body() };
    const result = await inspect(URL_, init, 1000);
    expect(result.record).toEqual({ url: URL_, headers: { authorization: "Bearer t", "x-session-id": "ses_1" }, body: body(), sentAt: 1000, sessionID: "ses_1", sessionVia: "guard-header" });
    expect(new Headers(result.init!.headers).has(SESSION_HEADER)).toBe(false);
    expect(new Headers(result.init!.headers).get("authorization")).toBe("Bearer t");
  });

  test("falls back to opencode's own X-Session-Id header", async () => {
    const result = await inspect(URL_, { method: "POST", headers: new Headers({ "X-Session-Id": "ses_2" }), body: body() }, 1);
    expect(result.record?.sessionID).toBe("ses_2");
    expect(result.record?.sessionVia).toBe("x-session-id");
  });

  test("ignores calls without tools, other URLs and other methods", async () => {
    expect((await inspect(URL_, { method: "POST", body: body({ tools: undefined }) }, 1)).record).toBeUndefined();
    expect((await inspect(URL_, { method: "POST", body: body({ tools: [] }) }, 1)).record).toBeUndefined();
    expect((await inspect("https://api.anthropic.com/v1/messages/count_tokens", { method: "POST", body: body() }, 1)).record).toBeUndefined();
    expect((await inspect("https://api.openai.com/v1/responses", { method: "POST", body: body() }, 1)).record).toBeUndefined();
    expect((await inspect(URL_, { method: "GET" }, 1)).record).toBeUndefined();
    expect((await inspect(URL_, { method: "POST", body: "not json" }, 1)).record).toBeUndefined();
  });

  test("reads a Request object's body and headers", async () => {
    const request = new Request(URL_, { method: "POST", headers: { [SESSION_HEADER]: "ses_3" }, body: body() });
    const result = await inspect(request, undefined, 5);
    expect(result.record?.sessionID).toBe("ses_3");
    expect(result.record?.body).toBe(body());
    expect((result.input as Request).headers.has(SESSION_HEADER)).toBe(false);
    expect(await (result.input as Request).text()).toBe(body()); // still readable downstream
  });

  test("matches /v1/messages on any host", () => {
    expect(isAnthropicMessages("https://proxy.example/v1/messages")).toBe(true);
    expect(isAnthropicMessages("https://api.anthropic.com/v1/messages?beta=true")).toBe(true);
    expect(isAnthropicMessages("https://api.anthropic.com/v1/complete")).toBe(false);
    expect(isAnthropicMessages("nope")).toBe(false);
  });
});

describe("replay", () => {
  test("sends the same request with one output token, no stream, JSON accepted", () => {
    const record = { url: URL_, headers: { authorization: "Bearer t", "content-length": "999", accept: "text/event-stream" }, body: body(), sentAt: 0 };
    const replay = replayRequest(record);
    if ("refused" in replay) throw new Error(replay.refused);
    expect(replay.url).toBe(URL_);
    expect(replay.init.method).toBe("POST");
    expect(replay.init.headers).toEqual({ authorization: "Bearer t", accept: "application/json" });
    const sent = JSON.parse(replay.init.body as string);
    expect(sent.max_tokens).toBe(1);
    expect(sent.stream).toBe(false);
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(sent.tools).toEqual([{ name: "bash" }]);
  });

  test("refuses budget thinking, keeps adaptive thinking", () => {
    expect(replayRequest({ url: URL_, headers: {}, body: body({ thinking: { type: "enabled", budget_tokens: 8000 } }), sentAt: 0 })).toEqual({ refused: "budget thinking" });
    const replay = replayRequest({ url: URL_, headers: {}, body: body({ thinking: { type: "adaptive" } }), sentAt: 0 });
    expect("refused" in replay).toBe(false);
  });

  test("reads usage as the cache saw it", () => {
    expect(parseUsage({ usage: { input_tokens: 3, cache_read_input_tokens: 9000, cache_creation_input_tokens: 10, output_tokens: 1 } })).toEqual({ promptTokens: 9013, cacheRead: 9000, cacheWrite: 10 });
    expect(parseUsage({ error: {} })).toBeUndefined();
  });
});

describe("install", () => {
  afterEach(() => uninstall());

  test("wraps fetch once, reports records, forwards without the header, and restores", async () => {
    const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
    const fake = (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    globalThis.fetch = fake;
    const records: unknown[] = [];
    const original = install((record) => records.push(record), () => 42);
    expect(original).toBe(fake);
    expect(install(() => undefined)).toBe(fake); // idempotent
    expect(globalThis.fetch).not.toBe(fake);
    await globalThis.fetch(URL_, { method: "POST", headers: { [SESSION_HEADER]: "ses_9" }, body: body() });
    await globalThis.fetch("https://example.com/other", { method: "POST", body: "{}" });
    expect(records).toHaveLength(1);
    expect((records[0] as { sessionID: string; sentAt: number }).sessionID).toBe("ses_9");
    expect((records[0] as { sentAt: number }).sentAt).toBe(42);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init!.headers).has(SESSION_HEADER)).toBe(false);
    uninstall();
    expect(globalThis.fetch).toBe(fake);
  });
});
