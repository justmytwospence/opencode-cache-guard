import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.js";
import { GUIDANCE_OPTIONS, type HeldPrompt, choiceOptions, guidanceText, heldPrompt, shouldOffer, takeConfirm, takeGuidance, writeConfirm, writeGuidance } from "../src/holds.js";
import { type Actions, act, offer } from "../src/tui.js";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const sonnet = { input: 2, cacheRead: 0.2 };

function held(text = "go on"): HeldPrompt {
  return heldPrompt({
    text, agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, variant: "high",
    now: T0, line: "The prompt cache expired 10m ago.", reason: { kind: "expired", idleMs: 600_000 }, tokens: 601_000, price: sonnet, ttlMs: 300_000,
  });
}

describe("held prompt", () => {
  test("the record and the priced options, Keep first", () => {
    const h = held();
    expect(h.costs!.send).toBeCloseTo(1.5025, 3);
    expect(h.costs!.compact).toBeCloseTo(1.202, 3);
    const options = choiceOptions(h);
    expect(options.map((o) => o.value)).toEqual(["keep", "compact", "fresh", "send", "mute"]);
    expect(options[1]!.title).toBe("Compact first, then send (~$1.20)");
    expect(options[3]!.title).toBe("Send anyway (~$1.50)");
    const unpriced = choiceOptions({ ...h, costs: undefined });
    expect(unpriced[3]!.title).toBe("Send anyway");
    expect(unpriced[1]!.description).toContain("601k-token history");
  });

  test("guidance: default adds nothing, focus quotes the prompt, custom is the user's text", () => {
    const h = held("fix the flaky test");
    expect(guidanceText("default", h)).toBeUndefined();
    expect(guidanceText("focus", h)).toContain("fix the flaky test");
    expect(guidanceText("custom", h, "  keep the file list ")).toBe("keep the file list");
    expect(guidanceText("custom", h, "   ")).toBeUndefined();
    expect(GUIDANCE_OPTIONS.map((o) => o.value)).toEqual(["default", "focus", "custom"]);
  });

  test("one dialog per hold, none when warnings are off", () => {
    const h = held();
    expect(shouldOffer(DEFAULT_SETTINGS, h, undefined)).toBe(true);
    expect(shouldOffer(DEFAULT_SETTINGS, h, h.seq)).toBe(false);
    expect(shouldOffer(DEFAULT_SETTINGS, undefined, undefined)).toBe(false);
    expect(shouldOffer(mergeSettings(DEFAULT_SETTINGS, ['{"warn":{"enabled":false}}']), h, undefined)).toBe(false);
  });
});

describe("files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cg-holds-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a confirm authorises its text once, inside the window", () => {
    expect(takeConfirm(dir, "s", "x", T0, 120_000)).toEqual({ confirmed: false, mute: false });
    writeConfirm(dir, "s", " go on ");
    expect(takeConfirm(dir, "s", "other", Date.now(), 120_000)).toEqual({ confirmed: false, mute: false });
    expect(existsSync(path.join(dir, "s.confirm.json"))).toBe(false); // consumed either way
    writeConfirm(dir, "s", "go on", true);
    expect(takeConfirm(dir, "s", "go on", Date.now(), 120_000)).toEqual({ confirmed: true, mute: true });
    writeConfirm(dir, "s", "go on");
    expect(takeConfirm(dir, "s", "go on", Date.now() + 200_000, 120_000)).toEqual({ confirmed: false, mute: false });
  });

  test("guidance is taken once, and not when stale", () => {
    expect(takeGuidance(dir, "s", Date.now())).toBeUndefined();
    writeGuidance(dir, "s", "Keep the plan.");
    expect(takeGuidance(dir, "s", Date.now())).toBe("Keep the plan.");
    expect(takeGuidance(dir, "s", Date.now())).toBeUndefined();
    writeGuidance(dir, "s", "old");
    expect(takeGuidance(dir, "s", Date.now() + 2 * 3_600_000)).toBeUndefined();
  });
});

function fakeActions(overrides: Partial<Actions> = {}) {
  const log: string[] = [];
  const actions: Actions = {
    clearPrompt: () => log.push("clear"),
    confirm: (s, text, mute) => log.push(`confirm ${s} ${text}${mute ? " mute" : ""}`),
    guidance: (s, text) => log.push(`guidance ${s} ${text.split("\n")[0]}`),
    submit: async (s, h) => { log.push(`submit ${s} ${h.text}`); },
    compact: async (s) => { log.push(`compact ${s}`); },
    create: async () => { log.push("create"); return "n1"; },
    navigate: (s) => log.push(`navigate ${s}`),
    toast: (message, variant) => log.push(`toast ${variant} ${message}`),
    ...overrides,
  };
  return { actions, log };
}

describe("choices", () => {
  test("send and mute authorise then submit; the box is emptied first", async () => {
    const { actions, log } = fakeActions();
    await act("send", "s", held(), actions);
    expect(log).toEqual(["clear", "confirm s go on", "submit s go on"]);
    log.length = 0;
    await act("mute", "s", held(), actions);
    expect(log).toEqual(["clear", "confirm s go on mute", "submit s go on"]);
  });

  test("compact leaves guidance, compacts, then sends; a failed compaction keeps the prompt", async () => {
    const { actions, log } = fakeActions();
    await act("compact", "s", held(), actions, "Keep the plan.");
    expect(log).toEqual(["guidance s Keep the plan.", "compact s", "clear", "confirm s go on", "submit s go on"]);
    const failing = fakeActions({ compact: async () => { throw new Error("no model"); } });
    await act("compact", "s", held(), failing.actions);
    expect(failing.log).toEqual(["toast error Compaction failed (no model); the prompt is still in the box."]);
  });

  test("fresh creates a session, moves there and sends; a failed create keeps the prompt", async () => {
    const { actions, log } = fakeActions();
    await act("fresh", "s", held(), actions);
    expect(log).toEqual(["create", "clear", "navigate n1", "submit n1 go on"]);
    const failing = fakeActions({ create: async () => undefined });
    await act("fresh", "s", held(), failing.actions);
    expect(failing.log).toEqual(["toast error Creating a session failed; the prompt is still in the box."]);
  });

  test("the dialog: keep closes; compact asks for guidance; custom guidance goes through a prompt", async () => {
    const { actions, log } = fakeActions();
    const rendered: any[] = [];
    const dialog = { replace: vi.fn((render: () => unknown) => rendered.push(render())), clear: vi.fn() };
    const ui = { dialog, select: (props: any) => ({ kind: "select", ...props }), prompt: (props: any) => ({ kind: "prompt", ...props }) } as any;
    offer(ui, "s", held(), actions);
    const first = rendered.at(-1);
    expect(first.kind).toBe("select");
    expect(first.title).toContain("Prompt cache miss");
    expect(first.options.map((o: any) => o.value)).toEqual(["keep", "compact", "fresh", "send", "mute"]);
    first.options[0].onSelect();
    expect(dialog.clear).toHaveBeenCalledTimes(1);
    expect(log).toEqual([]);

    first.options[1].onSelect();
    const guidance = rendered.at(-1);
    expect(guidance.title).toBe("Compact with");
    expect(guidance.options.map((o: any) => o.value)).toEqual(["default", "focus", "custom"]);
    guidance.options[2].onSelect();
    const prompt = rendered.at(-1);
    expect(prompt.kind).toBe("prompt");
    prompt.onConfirm("Keep the file list.");
    await vi.waitFor(() => expect(log).toContain("submit s go on"));
    expect(log).toEqual(["guidance s Keep the file list.", "compact s", "clear", "confirm s go on", "submit s go on"]);

    log.length = 0;
    first.options[3].onSelect();
    await vi.waitFor(() => expect(log).toContain("submit s go on"));
    expect(log).toEqual(["clear", "confirm s go on", "submit s go on"]);
  });
});
