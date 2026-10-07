import { describe, expect, test } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.js";
import { HerdrReporter, herdrRequest, herdrTarget, sendHerdr } from "../src/herdr.ts";
import { coldReasonOf, herdrValue, view } from "../src/status.js";
import type { SessionSnapshot } from "../src/warmer.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const opus = { input: 4, cacheRead: 0.2, cacheWrite: 5 };
const snap = (over: Partial<SessionSnapshot>): SessionSnapshot => ({
  sessionID: "s", lastAt: NOW - 60_000, lastRealAt: NOW - 60_000, ttlMs: 300_000, tokens: 600_000, warming: false, warms: 0, price: opus, updatedAt: NOW, ...over,
});

describe("status", () => {
  test("view and cold reason follow the TTL, or the idle limit without one", () => {
    expect(view(snap({}), NOW, DEFAULT_SETTINGS)).toEqual({ left: "4:00", warms: 0 });
    expect(coldReasonOf(snap({}), NOW, DEFAULT_SETTINGS)).toBeUndefined();
    expect(coldReasonOf(snap({ lastAt: NOW - 900_000 }), NOW, DEFAULT_SETTINGS)).toEqual({ kind: "expired", idleMs: 600_000 });
    expect(coldReasonOf(snap({ ttlMs: undefined, lastAt: NOW - 4 * 3_600_000 }), NOW, DEFAULT_SETTINGS)).toEqual({ kind: "idle", idleMs: 4 * 3_600_000 });
    expect(coldReasonOf(undefined, NOW, DEFAULT_SETTINGS)).toBeUndefined();
  });

  test("herdr token: big cold caches only, priced from the snapshot", () => {
    expect(herdrValue(snap({}), NOW, DEFAULT_SETTINGS)).toBeUndefined();
    expect(herdrValue(snap({ lastAt: NOW - 900_000 }), NOW, DEFAULT_SETTINGS)).toBe("cold 600k");
    expect(herdrValue(snap({ lastAt: NOW - 900_000, tokens: 50_000 }), NOW, DEFAULT_SETTINGS)).toBeUndefined();
    // No price (an OpenAI session): the token threshold applies, and the idle guess is marked.
    expect(herdrValue(snap({ price: undefined, ttlMs: undefined, lastAt: NOW - 4 * 3_600_000, tokens: 180_000 }), NOW, DEFAULT_SETTINGS)).toBe("cold? 180k");
    expect(herdrValue(snap({ lastAt: NOW - 900_000 }), NOW, mergeSettings(DEFAULT_SETTINGS, ['{"herdr":{"enabled":false}}']))).toBeUndefined();
  });
});

describe("herdr", () => {
  test("the reporter sends on change only, clears once", async () => {
    const sent: Array<Record<string, any>> = [];
    const r = new HerdrReporter("opencode", { socketPath: "/s", paneId: "w1:p1" }, async (_t, request) => { sent.push(request.params as Record<string, any>); return true; });
    r.report(undefined);
    r.report(undefined);
    expect(sent.map((p) => p.tokens.cache)).toEqual([null]); // a stale token from an earlier run is cleared once
    r.report("cold 600k");
    r.report("cold 600k");
    expect(sent.at(-1)).toMatchObject({ pane_id: "w1:p1", source: "cache-guard", agent: "opencode", tokens: { cache: "cold 600k" }, ttl_ms: 86_400_000 });
    expect(sent.length).toBe(2);
    await r.clear();
    expect(sent.at(-1)!.tokens.cache).toBeNull();
    expect(sent.length).toBe(3);
    expect(herdrTarget({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toEqual({ socketPath: "/s", paneId: "w1:p1" });
    expect(herdrTarget({ HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toBeUndefined();
  });

  test("speaks herdr's socket protocol", async () => {
    const net = await import("node:net");
    const os = await import("node:os");
    const path = await import("node:path");
    const socketPath = path.join(os.tmpdir(), `ocg-${process.pid}.sock`);
    const lines: string[] = [];
    const server = net.createServer((socket) => socket.on("data", (data) => { lines.push(String(data)); socket.end('{"id":"x","result":{}}\n'); }));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const target = { socketPath, paneId: "w1:p2" };
      expect(await sendHerdr(target, herdrRequest(target, "opencode", "cold 1M"))).toBe(true);
      const request = JSON.parse(lines[0]!);
      expect(request.method).toBe("pane.report_metadata");
      expect(request.params).toMatchObject({ pane_id: "w1:p2", source: "cache-guard", agent: "opencode", tokens: { cache: "cold 1M" } });
      expect(await sendHerdr({ socketPath: "/nonexistent.sock", paneId: "x" }, request)).toBe(false);
    } finally {
      server.close();
    }
  });
});
