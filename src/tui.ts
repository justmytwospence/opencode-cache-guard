// opencode-cache-guard (TUI): the prompt cache's time left, to the right of the prompt, and the
// choices when the server half holds a prompt: keep it, continue on Jev's summary in a new
// session, compact first, start fresh, send anyway, or send and stop asking. Reads the state file
// the server half writes for the session once a second, and at once when the server publishes the
// hold command. The `cache-guard.jev` command ("cache-guard: Jev" in the palette, `/cache-guard-jev`)
// shows whether Jev is set up, checks that it answers, and turns it off or on.
//
// Plain TypeScript rather than JSX, with Solid taken from opencode: see host.ts.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";

import { type Summary, jevSummary } from "./compact.js";
import { type Settings } from "./core.js";
import { HerdrReporter } from "./herdr.ts";
import { GUIDANCE_OPTIONS, HOLD_COMMAND, type HeldPrompt, choiceOptions, choiceTitle, guidanceText, shouldOffer, writeConfirm, writeGuidance } from "./holds.js";
import { type Segment, line, loadHost } from "./host.ts";
import { type JevOutcome, type JevState, askJev, label, probe, resolveJev } from "./jev.js";
import { JEV_KEY_URL, JEV_PITCH } from "./lean.js";
import { loadSettings, saveUserSettings, stateDir } from "./settings.js";
import { type View, herdrValue, readSnapshot, view } from "./status.js";
import type { MessageLike } from "./units.js";

/** The palette command: "cache-guard: Jev", also `/cache-guard-jev`. */
export const JEV_COMMAND = "cache-guard.jev";
export const JEV_SLASH = "cache-guard-jev";

/** `cache 4:12 ↻2`, or `cache cold` in the warning color; undefined shows nothing. */
export function segments<Color>(v: View | undefined, warning: Color): Segment<Color>[] | undefined {
  if (!v) return undefined;
  const out: Segment<Color>[] = [{ text: "cache " }];
  out.push(v.left ? { text: v.left } : { text: v.cold ?? "", color: warning });
  if (v.warms > 0) out.push({ text: ` \u21bb${v.warms}` });
  return out;
}

/** What the choices need from the TUI; a seam for tests. */
export interface Actions {
  /** Closes the dialog, and empties the prompt box (the held text is in it). */
  clearPrompt: () => void;
  confirm: (sessionID: string, text: string, mute?: boolean) => void;
  guidance: (sessionID: string, text: string) => void;
  /** Sends `text` into the session the way the TUI would have; `prefix` goes first, as its own text part. */
  submit: (sessionID: string, held: HeldPrompt, prefix?: string) => Promise<void>;
  /** Compacts the session with its current model, resolving once done. */
  compact: (sessionID: string) => Promise<void>;
  /** A new session with the held prompt's agent and model; its id. */
  create: (held: HeldPrompt) => Promise<string | undefined>;
  navigate: (sessionID: string) => void;
  toast: (message: string, variant: "warning" | "error" | "info") => void;
  /** Jev's summary of the session, judged against the held prompt; written in code. */
  jevSummary: (sessionID: string, held: HeldPrompt) => Promise<Summary>;
}

/**
 * Runs one choice. The held text stays in the prompt box until the choice sends it, so a choice
 * that fails before sending (a compaction, a Jev pass or a session creation that errors) leaves
 * it there.
 */
export async function act(choice: "jev" | "compact" | "fresh" | "send" | "mute", sessionID: string, held: HeldPrompt, actions: Actions, guidance?: string): Promise<void> {
  if (choice === "send" || choice === "mute") {
    actions.clearPrompt();
    actions.confirm(sessionID, held.text, choice === "mute");
    await actions.submit(sessionID, held);
    return;
  }
  if (choice === "compact") {
    if (guidance) actions.guidance(sessionID, guidance);
    try {
      await actions.compact(sessionID);
    } catch (error) {
      actions.toast(`Compaction failed (${error instanceof Error ? error.message : String(error)}); the prompt is still in the box.`, "error");
      return;
    }
    actions.clearPrompt();
    // The compacted session has a fresh context, so nothing holds the send; the confirm covers a
    // compaction opencode skipped.
    actions.confirm(sessionID, held.text);
    await actions.submit(sessionID, held);
    return;
  }
  let summary: string | undefined;
  if (choice === "jev") {
    // Jev judges the history against the held prompt; the summary is written in code and opens the
    // new session, followed by the prompt. If Jev fails nothing is sent and nothing is spent.
    const result = await actions.jevSummary(sessionID, held);
    if (!result.ok) {
      actions.toast(`Jev could not summarize the session (${result.reason}); the prompt is still in the box.`, "error");
      return;
    }
    summary = result.summary;
    actions.toast(`Jev kept ${result.counts.verbatim} of ${result.units} items word for word in ${(result.latencyMs / 1000).toFixed(1)} s; continuing in a new session.`, "info");
  }
  const created = await actions.create(held);
  if (!created) {
    actions.toast("Creating a session failed; the prompt is still in the box.", "error");
    return;
  }
  actions.clearPrompt();
  actions.navigate(created);
  await actions.submit(created, held, summary);
}

type Dialog = { replace: (render: () => never) => void; clear: () => void };
type Ui = { dialog: Dialog; select: (props: unknown) => never; prompt: (props: unknown) => never };

/** Whether the dialog offers Jev, and whether it shows the tip for setting Jev up. */
export function jevOffer(state: JevState): { ready: boolean; tip: boolean } {
  return { ready: state.kind === "ready", tip: state.kind === "missing" };
}

/** The choice dialog, then (for compaction) the guidance dialog or prompt. */
export function offer(ui: Ui, sessionID: string, held: HeldPrompt, actions: Actions, jev: { ready: boolean; tip: boolean } = { ready: false, tip: false }): void {
  const run = (choice: "jev" | "compact" | "fresh" | "send" | "mute", guidance?: string) => {
    ui.dialog.clear();
    void act(choice, sessionID, held, actions, guidance).catch((error) => {
      actions.toast(`cache-guard: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  };
  const askGuidance = () => {
    ui.dialog.replace(() =>
      ui.select({
        title: "Compact with",
        options: GUIDANCE_OPTIONS.map((option) => ({
          title: option.title,
          value: option.value,
          description: option.description,
          onSelect: () => {
            if (option.value === "custom") {
              ui.dialog.replace(() =>
                ui.prompt({
                  title: "Compaction guidance",
                  placeholder: "What the summary should keep or stress",
                  onConfirm: (value: string) => run("compact", guidanceText("custom", held, value)),
                  onCancel: () => ui.dialog.clear(),
                }),
              );
              return;
            }
            run("compact", guidanceText(option.value, held));
          },
        })),
      }),
    );
  };
  ui.dialog.replace(() =>
    ui.select({
      title: choiceTitle(held, jev),
      options: choiceOptions(held, jev).map((option) => ({
        title: option.title,
        value: option.value,
        description: option.description,
        onSelect: () => {
          if (option.value === "keep") ui.dialog.clear();
          else if (option.value === "compact") askGuidance();
          else run(option.value);
        },
      })),
    }),
  );
}

/** What the Jev command needs; a seam for tests. */
export interface JevCommandDeps {
  settings: () => Settings;
  /** Jev as the settings and environment allow it now. */
  state: () => JevState;
  probe: () => Promise<JevOutcome>;
  /** Merge into the user settings file; throws when it cannot. */
  save: (patch: Record<string, unknown>) => void;
  select: (title: string, options: Array<{ title: string; description?: string; onSelect: () => void }>) => void;
  toast: (message: string, variant: "warning" | "error" | "info") => void;
}

const JEV_OFF_LINE = "Jev is off: no trimming, no Jev summary, no tips.";
const JEV_USES = "It trims large tool output, continues a cold cache on a one-second summary, and marks what a compaction must keep word for word.";

/**
 * `cache-guard: Jev`: whether Jev is set up and answers (and how fast), how to set it up, and
 * turning it off or on (`jev.enabled` in ~/.config/opencode/cache-guard.json).
 */
export async function jevCommand(deps: JevCommandDeps): Promise<void> {
  const save = (patch: Record<string, unknown>) => {
    try {
      deps.save({ jev: patch });
      return true;
    } catch (error) {
      deps.toast(`Could not save the setting: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
  };
  const settings = deps.settings();
  if (!settings.enabled) {
    deps.toast("cache-guard is off in its settings (\"enabled\": false), Jev included.", "info");
    return;
  }
  if (!settings.jev.enabled) {
    deps.select(`${JEV_OFF_LINE}\n${JEV_PITCH}`, [
      { title: "Turn Jev on", description: "jev.enabled: true in ~/.config/opencode/cache-guard.json", onSelect: () => void (save({ enabled: true }) && jevCommand(deps)) },
      { title: "Leave it off", onSelect: () => undefined },
    ]);
    return;
  }
  const state = deps.state();
  if (state.kind === "off") return;
  const off = (tips: boolean) => {
    if (save({ enabled: false })) deps.toast(`Jev is off: no trimming, no Jev summary${tips ? ", no tips" : ""}. cache-guard: Jev turns it back on.`, "info");
  };
  if (state.kind === "ready") {
    const answer = await deps.probe();
    const head = answer.ok ? `Jev: ${label(state.target)}, answered in ${answer.latencyMs} ms.` : `Jev: ${label(state.target)} did not answer (${answer.reason}).`;
    deps.select(`${head} ${JEV_USES}`, [
      { title: "Done", onSelect: () => undefined },
      { title: "Turn Jev off", description: "No trimming, no Jev summary, no tips.", onSelect: () => off(false) },
    ]);
    return;
  }
  const options = [
    { title: "Done", description: "Set the key in opencode's environment, restart it, and run this again to check.", onSelect: () => undefined },
    ...(settings.jev.provider.trim()
      ? [{ title: "Use TypeSafe's API (clear jev.provider)", onSelect: () => void (save({ provider: "", model: "" }) && jevCommand(deps)) }]
      : []),
    { title: "Turn Jev off (no more tips)", onSelect: () => off(true) },
  ];
  deps.select(
    `Jev is not set up: ${state.reason}.\n${JEV_PITCH}\nIt needs a TypeSafe API key from ${JEV_KEY_URL}, as TYPESAFE_API_KEY in opencode's environment.`,
    options,
  );
}

/** What the TUI needs beyond opencode's API; a seam for tests. */
export interface TuiOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** The actions on opencode's TUI plugin API. */
export function tuiActions(api: TuiPluginApi, dir: string, settings: () => Settings, extra: TuiOptions = {}): Actions {
  const client = api.client;
  const env = extra.env ?? process.env;
  const sessionModel = (sessionID: string, held: HeldPrompt) => {
    const current = api.state.session.get(sessionID)?.model;
    return held.model ?? (current ? { providerID: current.providerID, modelID: current.id } : undefined);
  };
  return {
    clearPrompt: () => {
      api.ui.dialog.clear();
      api.keymap.dispatchCommand("prompt.clear");
    },
    confirm: (sessionID, text, mute) => writeConfirm(dir, sessionID, text, mute),
    guidance: (sessionID, text) => writeGuidance(dir, sessionID, text),
    submit: async (sessionID, held, prefix) => {
      const session = api.state.session.get(sessionID);
      await client.session.prompt(
        {
          sessionID,
          directory: session?.directory,
          workspace: session?.workspaceID,
          agent: held.agent,
          model: sessionModel(sessionID, held),
          variant: held.variant,
          parts: [...(prefix ? [{ type: "text" as const, text: prefix }] : []), { type: "text" as const, text: held.text }],
        },
        { throwOnError: true },
      );
    },
    compact: async (sessionID) => {
      const session = api.state.session.get(sessionID);
      const model = session?.model;
      await client.session.summarize(
        { sessionID, directory: session?.directory, workspace: session?.workspaceID, providerID: model?.providerID, modelID: model?.id },
        { throwOnError: true },
      );
    },
    create: async (held) => {
      const result = await client.session.create({
        agent: held.agent,
        model: held.model ? { providerID: held.model.providerID, id: held.model.modelID, variant: held.variant } : undefined,
      });
      return result.data?.id;
    },
    navigate: (sessionID) => api.route.navigate("session", { sessionID }),
    toast: (message, variant) => api.ui.toast({ title: "cache-guard", message, variant, duration: 8_000 }),
    jevSummary: async (sessionID, held) => {
      const s = settings();
      const jev = resolveJev(s, env);
      if (jev.kind !== "ready") return { ok: false, reason: jev.kind === "off" ? "Jev is off" : jev.reason };
      const session = api.state.session.get(sessionID);
      const result = await client.session.messages({ sessionID, directory: session?.directory, workspace: session?.workspaceID }, { throwOnError: true });
      const messages = (result.data ?? []) as unknown as MessageLike[];
      return jevSummary(messages, held.text, s.compact, (state, questions) =>
        askJev(state, questions, { model: jev.target.model, timeoutMs: s.compact.timeoutMs, apiKey: env.TYPESAFE_API_KEY, ...(extra.fetch ? { fetch: extra.fetch } : {}) }),
      );
    },
  };
}

const tui: TuiPlugin = async (api, options) => {
  const host = await loadHost();
  const dir = stateDir();
  const directory = api.state.path.directory || process.cwd();
  // Re-read when a hold is offered and by the Jev command, so a settings edit (or the command's
  // own toggle) applies without a restart; the tick keeps the last copy.
  let settings = loadSettings(directory, process.env, options);
  const settingsNow = () => (settings = loadSettings(directory, process.env, options));
  const [now, setNow] = host.solid.createSignal(Date.now());
  // Inside a herdr pane: the `cache` token for the session on screen, so herdr's agents sidebar
  // lists this pane while its next prompt is doomed to a cache miss. The home screen shows no
  // session, so the token clears there.
  const herdr = new HerdrReporter("opencode");
  const shownSession = () => {
    const route = api.route.current;
    return route.name === "session" ? String(route.params?.sessionID ?? "") : "";
  };
  const report = () => {
    const shown = shownSession();
    herdr.report(shown ? herdrValue(readSnapshot(dir, shown), Date.now(), settings) : undefined);
  };
  // One dialog per hold: the seq of the hold last offered, per session.
  const offered = new Map<string, number>();
  const actions = tuiActions(api, dir, () => settings);
  const ui: Ui = {
    dialog: api.ui.dialog as unknown as Dialog,
    select: (props: unknown) => host.jsx(api.ui.DialogSelect as never, props as never) as never,
    prompt: (props: unknown) => host.jsx(api.ui.DialogPrompt as never, props as never) as never,
  };
  const check = () => {
    const shown = shownSession();
    if (!shown) return;
    const held = readSnapshot(dir, shown)?.held;
    if (!held || held.seq === offered.get(shown)) return;
    if (!shouldOffer(settingsNow(), held, offered.get(shown))) return;
    offered.set(shown, held.seq);
    offer(ui, shown, held, actions, jevOffer(resolveJev(settings)));
  };
  const jev = () =>
    jevCommand({
      settings: settingsNow,
      state: () => resolveJev(settings),
      probe: () => probe({ model: settings.jev.model, apiKey: process.env.TYPESAFE_API_KEY }),
      save: (patch) => {
        saveUserSettings(patch);
        settingsNow();
      },
      select: (title, options) =>
        ui.dialog.replace(() =>
          ui.select({
            title,
            options: options.map((option, index) => ({
              title: option.title,
              value: index,
              description: option.description,
              onSelect: () => {
                ui.dialog.clear();
                option.onSelect();
              },
            })),
          }),
        ),
      toast: (message, variant) => api.ui.toast({ title: "cache-guard", message, variant, duration: 8_000 }),
    });
  api.keymap.registerLayer({
    commands: [
      { name: HOLD_COMMAND, title: "Prompt cache miss: choose", category: "Session", hidden: true, run: () => check() },
      {
        namespace: "palette",
        name: JEV_COMMAND,
        title: "cache-guard: Jev",
        category: "Session",
        slashName: JEV_SLASH,
        run: () => void jev().catch((error: unknown) => api.ui.toast({ title: "cache-guard", message: error instanceof Error ? error.message : String(error), variant: "error" })),
      },
    ],
  } as never);
  const ticker = setInterval(() => {
    setNow(Date.now());
    report();
    check();
  }, 1000);
  api.lifecycle.onDispose(async () => {
    clearInterval(ticker);
    await herdr.clear();
  });
  const theme = () => api.theme.current;
  api.slots.register({
    order: 310,
    slots: {
      session_prompt_right: (_ctx, props) =>
        line(
          host,
          () => theme().textMuted,
          () => segments(view(readSnapshot(dir, props.session_id), now(), settings), theme().warning),
        ),
    },
  });
};

export default { id: "opencode-cache-guard-tui", tui };
