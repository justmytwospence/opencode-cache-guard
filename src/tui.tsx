/** @jsxImportSource @opentui/solid */
// opencode-cache-guard (TUI): the prompt cache's time left, to the right of the prompt. Reads the
// state file the server half writes for the session once a second.
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { Show, createSignal } from "solid-js";

import { loadSettings, stateDir } from "./settings.js";
import { type View, readSnapshot, view } from "./status.js";

function Status(props: { api: TuiPluginApi; view: View | undefined }) {
  const theme = () => props.api.theme.current;
  return (
    <Show when={props.view}>
      <text fg={theme().textMuted} wrapMode="none">
        {"cache "}
        <Show when={props.view!.left} fallback={<span style={{ fg: theme().warning }}>{props.view!.cold}</span>}>
          {props.view!.left}
        </Show>
        <Show when={props.view!.warms > 0}>{` \u21bb${props.view!.warms}`}</Show>
      </text>
    </Show>
  );
}

const tui: TuiPlugin = async (api) => {
  const dir = stateDir();
  const settings = loadSettings(api.state.path.directory || process.cwd());
  const [now, setNow] = createSignal(Date.now());
  const ticker = setInterval(() => setNow(Date.now()), 1000);
  api.lifecycle.onDispose(async () => clearInterval(ticker));
  api.slots.register({
    order: 310,
    slots: {
      session_prompt_right: (_ctx, props) => (
        <Status api={api} view={view(readSnapshot(dir, props.session_id), now(), settings)} />
      ),
    },
  });
};

export default { id: "opencode-cache-guard-tui", tui };
