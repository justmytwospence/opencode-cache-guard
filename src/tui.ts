// opencode-cache-guard (TUI): the prompt cache's time left, to the right of the prompt, and the
// choices when the server half holds a prompt: keep it, compact first, start fresh, send anyway,
// or send and stop asking. Reads the state file the server half writes for the session once a
// second, and at once when the server publishes the hold command.
//
// Plain TypeScript rather than JSX, with Solid taken from opencode: see host.ts.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";

import { HerdrReporter } from "./herdr.ts";
import { GUIDANCE_OPTIONS, HOLD_COMMAND, type HeldPrompt, choiceOptions, guidanceText, shouldOffer, writeConfirm, writeGuidance } from "./holds.js";
import { type Segment, line, loadHost } from "./host.ts";
import { loadSettings, stateDir } from "./settings.js";
import { type View, herdrValue, readSnapshot, view } from "./status.js";

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
  /** Sends `text` into the session the way the TUI would have. */
  submit: (sessionID: string, held: HeldPrompt) => Promise<void>;
  /** Compacts the session with its current model, resolving once done. */
  compact: (sessionID: string) => Promise<void>;
  /** A new session with the held prompt's agent and model; its id. */
  create: (held: HeldPrompt) => Promise<string | undefined>;
  navigate: (sessionID: string) => void;
  toast: (message: string, variant: "warning" | "error" | "info") => void;
}

/**
 * Runs one choice. The held text stays in the prompt box until the choice sends it, so a choice
 * that fails before sending (a compaction or session creation that errors) leaves it there.
 */
export async function act(choice: "compact" | "fresh" | "send" | "mute", sessionID: string, held: HeldPrompt, actions: Actions, guidance?: string): Promise<void> {
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
  const created = await actions.create(held);
  if (!created) {
    actions.toast("Creating a session failed; the prompt is still in the box.", "error");
    return;
  }
  actions.clearPrompt();
  actions.navigate(created);
  await actions.submit(created, held);
}

type Dialog = { replace: (render: () => never) => void; clear: () => void };

/** The choice dialog, then (for compaction) the guidance dialog or prompt. */
export function offer(ui: { dialog: Dialog; select: (props: unknown) => never; prompt: (props: unknown) => never }, sessionID: string, held: HeldPrompt, actions: Actions): void {
  const run = (choice: "compact" | "fresh" | "send" | "mute", guidance?: string) => {
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
      title: `Prompt cache miss. ${held.line}`,
      options: choiceOptions(held).map((option) => ({
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

/** The actions on opencode's TUI plugin API. */
export function tuiActions(api: TuiPluginApi, dir: string): Actions {
  const client = api.client;
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
    submit: async (sessionID, held) => {
      const session = api.state.session.get(sessionID);
      await client.session.prompt(
        {
          sessionID,
          directory: session?.directory,
          workspace: session?.workspaceID,
          agent: held.agent,
          model: sessionModel(sessionID, held),
          variant: held.variant,
          parts: [{ type: "text", text: held.text }],
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
  };
}

const tui: TuiPlugin = async (api) => {
  const host = await loadHost();
  const dir = stateDir();
  const settings = loadSettings(api.state.path.directory || process.cwd());
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
  const actions = tuiActions(api, dir);
  const ui = {
    dialog: api.ui.dialog as unknown as Dialog,
    select: (props: unknown) => host.jsx(api.ui.DialogSelect as never, props as never) as never,
    prompt: (props: unknown) => host.jsx(api.ui.DialogPrompt as never, props as never) as never,
  };
  const check = () => {
    const shown = shownSession();
    if (!shown) return;
    const held = readSnapshot(dir, shown)?.held;
    if (!shouldOffer(settings, held, offered.get(shown))) return;
    offered.set(shown, held.seq);
    offer(ui, shown, held, actions);
  };
  api.keymap.registerLayer({
    commands: [{ name: HOLD_COMMAND, title: "Prompt cache miss: choose", category: "Session", hidden: true, run: () => check() }],
  });
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
