// opencode-cache-guard (TUI): the prompt cache's time left, to the right of the prompt. Reads the
// state file the server half writes for the session once a second.
//
// Plain TypeScript rather than JSX, with Solid taken from opencode: see host.ts.
import type { TuiPlugin } from "@opencode-ai/plugin/tui";

import { HerdrReporter } from "./herdr.ts";
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

const tui: TuiPlugin = async (api) => {
  const host = await loadHost();
  const dir = stateDir();
  const settings = loadSettings(api.state.path.directory || process.cwd());
  const [now, setNow] = host.solid.createSignal(Date.now());
  // Inside a herdr pane: the `cache` token for the session on screen, so herdr's agents sidebar
  // lists this pane while its next prompt is doomed to a cache miss. The home screen shows no
  // session, so the token clears there.
  const herdr = new HerdrReporter("opencode");
  const report = () => {
    const route = api.route.current;
    const shown = route.name === "session" ? String(route.params?.sessionID ?? "") : "";
    herdr.report(shown ? herdrValue(readSnapshot(dir, shown), Date.now(), settings) : undefined);
  };
  const ticker = setInterval(() => {
    setNow(Date.now());
    report();
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
