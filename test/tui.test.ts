import { expect, test, vi } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.js";
import type { JevState } from "../src/jev.js";
import { type JevCommandDeps, jevCommand, segments, tuiActions } from "../src/tui.js";
import { assistant, user } from "./messages.js";

test("warm: time left and keep-warm count in the line's color", () => {
  expect(segments({ left: "4:12", warms: 2 }, "W")).toEqual([{ text: "cache " }, { text: "4:12" }, { text: " \u21bb2" }]);
});

test("cold: in the warning color, no count when none", () => {
  expect(segments({ cold: "cold", warms: 0 }, "W")).toEqual([{ text: "cache " }, { text: "cold", color: "W" }]);
});

test("no state: nothing", () => {
  expect(segments(undefined, "W")).toBeUndefined();
});

function command(overrides: Partial<JevCommandDeps> & { settings?: () => ReturnType<typeof mergeSettings> } = {}) {
  const dialogs: Array<{ title: string; options: Array<{ title: string; description?: string; onSelect: () => void }> }> = [];
  const toasts: string[] = [];
  const saved: Record<string, unknown>[] = [];
  let settings = overrides.settings?.() ?? DEFAULT_SETTINGS;
  const deps: JevCommandDeps = {
    settings: () => settings,
    state: () => ({ kind: "ready", target: { provider: "typesafe", model: "jev-latest" } }) as JevState,
    probe: async () => ({ ok: true, answers: {}, model: "jev-latest", latencyMs: 312 }),
    save: (patch) => {
      saved.push(patch);
      settings = mergeSettings(settings, [JSON.stringify(patch)]);
    },
    select: (title, options) => dialogs.push({ title, options }),
    toast: (message, variant) => toasts.push(`${variant} ${message}`),
    ...overrides,
  };
  return { deps, dialogs, toasts, saved };
}

test("cache-guard: Jev, when set up, probes it, shows the latency and can turn it off", async () => {
  const { deps, dialogs, toasts, saved } = command();
  await jevCommand(deps);
  expect(dialogs[0]!.title).toMatch(/^Jev: typesafe\/jev-latest, answered in 312 ms\. It trims large tool output/u);
  expect(dialogs[0]!.options.map((o) => o.title)).toEqual(["Done", "Turn Jev off"]);
  dialogs[0]!.options[1]!.onSelect();
  expect(saved).toEqual([{ jev: { enabled: false } }]);
  expect(toasts).toEqual(["info Jev is off: no trimming, no Jev summary. cache-guard: Jev turns it back on."]);
  // Off: offers to turn it on, which checks again.
  await jevCommand(deps);
  expect(dialogs[1]!.title).toMatch(/^Jev is off: no trimming, no Jev summary, no tips\.\nJev, TypeSafe's judgment model/u);
  expect(dialogs[1]!.options.map((o) => o.title)).toEqual(["Turn Jev on", "Leave it off"]);
  dialogs[1]!.options[0]!.onSelect();
  await vi.waitFor(() => expect(dialogs).toHaveLength(3));
  expect(saved.at(-1)).toEqual({ jev: { enabled: true } });
  expect(dialogs[2]!.title).toContain("answered in 312 ms");
  // A probe that fails says so.
  const down = command({ probe: async () => ({ ok: false, reason: "invalid API key" }) });
  await jevCommand(down.deps);
  expect(down.dialogs[0]!.title).toMatch(/^Jev: typesafe\/jev-latest did not answer \(invalid API key\)\./u);
});

test("cache-guard: Jev, when not set up, explains the key and can turn the tips off", async () => {
  const { deps, dialogs, toasts, saved } = command({ state: () => ({ kind: "missing", reason: "TYPESAFE_API_KEY is not set" }) });
  await jevCommand(deps);
  expect(dialogs[0]!.title).toBe("Jev is not set up: TYPESAFE_API_KEY is not set.\nJev, TypeSafe's judgment model, trims large tool output to what the agent needs and compacts a conversation in about a second, without an LLM summary.\nIt needs a TypeSafe API key from https://console.typesafe.ai/keys, as TYPESAFE_API_KEY in opencode's environment.");
  expect(dialogs[0]!.options.map((o) => o.title)).toEqual(["Done", "Turn Jev off (no more tips)"]);
  dialogs[0]!.options[1]!.onSelect();
  expect(saved).toEqual([{ jev: { enabled: false } }]);
  expect(toasts).toEqual(["info Jev is off: no trimming, no Jev summary, no tips. cache-guard: Jev turns it back on."]);
  // Another provider configured: offer to clear it.
  const other = command({
    settings: () => mergeSettings(DEFAULT_SETTINGS, ['{"jev":{"provider":"openrouter"}}']),
    state: () => ({ kind: "missing", reason: 'jev.provider "openrouter" is not supported here' }),
  });
  await jevCommand(other.deps);
  expect(other.dialogs[0]!.options.map((o) => o.title)).toEqual(["Done", "Use TypeSafe's API (clear jev.provider)", "Turn Jev off (no more tips)"]);
  other.dialogs[0]!.options[1]!.onSelect();
  expect(other.saved).toEqual([{ jev: { provider: "", model: "" } }]);
  // A save that fails is reported, and nothing else happens.
  const broken = command({ save: () => { throw new Error("/x/cache-guard.json is not a JSON object"); } });
  await jevCommand(broken.deps);
  broken.dialogs[0]!.options[1]!.onSelect();
  expect(broken.toasts).toEqual(["error Could not save the setting: /x/cache-guard.json is not a JSON object"]);
  // Everything off: one toast.
  const all = command({ settings: () => mergeSettings(DEFAULT_SETTINGS, ['{"enabled":false}']) });
  await jevCommand(all.deps);
  expect(all.dialogs).toEqual([]);
  expect(all.toasts).toEqual(['info cache-guard is off in its settings ("enabled": false), Jev included.']);
});

/** A TUI plugin API with a session, its messages over the client, and what was sent or created. */
function fakeApi(messages: unknown[]) {
  const prompts: any[] = [];
  const api = {
    client: {
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        prompt: vi.fn(async (params: unknown) => { prompts.push(params); return { data: {} }; }),
        create: vi.fn(async () => ({ data: { id: "n1" } })),
        summarize: vi.fn(async () => ({ data: true })),
      },
    },
    state: { session: { get: () => ({ directory: "/p", workspaceID: "w", model: { providerID: "anthropic", id: "claude-sonnet-5-5" } }) } },
    ui: { dialog: { clear: vi.fn() }, toast: vi.fn() },
    keymap: { dispatchCommand: vi.fn() },
    route: { navigate: vi.fn() },
  };
  return { api, prompts };
}

const held = { text: "fix the parser", agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, variant: "high", at: 0, line: "", reason: "expired" as const, tokens: 600_000, seq: 1 };

test("the TUI's Jev summary reads the session over the client and judges it against the held prompt", async () => {
  const history = [user("Use pnpm, never npm."), assistant(["Exploring."], [{ tool: "bash", callID: "c1", input: { command: "ls" }, output: "a" }]), user("Now add a cache.")];
  const { api, prompts } = fakeApi(history);
  const sent: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push(body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "choice", choice: id === "keep::U001" ? "verbatim" : "drop", probabilities: {}, confidence: 1 }]));
    return new Response(JSON.stringify({ model: "jev-test", answers }));
  }) as unknown as typeof fetch;
  const actions = tuiActions(api as any, "/tmp/none", () => DEFAULT_SETTINGS, { fetch: fetchImpl, env: { TYPESAFE_API_KEY: "k" } });
  const result = await actions.jevSummary("s", held);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(api.client.session.messages).toHaveBeenCalledWith({ sessionID: "s", directory: "/p", workspace: "w" }, { throwOnError: true });
  expect(sent[0].state.current_goal).toBe("fix the parser");
  expect(sent[0].model).toBe("jev-latest");
  expect(result.summary).toContain("**User:** Use pnpm, never npm.");
  expect(result.counts).toEqual({ verbatim: 1, summarize: 0, drop: 3 });
  // The summary goes out first, then the prompt, in one message with the held agent and model.
  await actions.submit("n1", held, result.summary);
  expect(prompts[0]).toMatchObject({ sessionID: "n1", agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }, variant: "high" });
  expect(prompts[0].parts.map((p: any) => p.text)).toEqual([result.summary, "fix the parser"]);
  // Without a key, or with Jev off, no request is made.
  const noKey = tuiActions(api as any, "/tmp/none", () => DEFAULT_SETTINGS, { fetch: fetchImpl, env: {} });
  expect(await noKey.jevSummary("s", held)).toEqual({ ok: false, reason: "TYPESAFE_API_KEY is not set" });
  const off = tuiActions(api as any, "/tmp/none", () => mergeSettings(DEFAULT_SETTINGS, ['{"jev":{"enabled":false}}']), { fetch: fetchImpl, env: { TYPESAFE_API_KEY: "k" } });
  expect(await off.jevSummary("s", held)).toEqual({ ok: false, reason: "Jev is off" });
  expect(sent).toHaveLength(1);
});
