# opencode-cache-guard

An [opencode](https://opencode.ai) plugin that keeps the Anthropic prompt cache warm between
turns, asks before a prompt that would re-cache a large conversation, shows how long the cache has
left beside the prompt, and, with [Jev](https://docs.typesafe.ai) (TypeSafe's fast judgment model),
keeps the context lean: large tool output is trimmed to what the agent needs, a cold cache can
continue on a summary written in about a second, and a compaction is told what to keep word for
word. Everything but the Jev parts works without Jev.

The opencode port of [pi-cache-guard](https://github.com/justmytwospence/pi-cache-guard);
`src/core.ts` (the cache clock, the cost of a miss, when a refresh or a warning pays, the settings),
`src/lean.ts` (the Jev trimming and compaction, with no harness imports) and the settings file are
shared with it and with [claude-cache-guard](https://github.com/justmytwospence/claude-cache-guard)
and [codex-cache-guard](https://github.com/justmytwospence/codex-cache-guard). It replaces
opencode-lean-context: remove that plugin from `opencode.jsonc`, since both would trim the same
output.

## What it does

Anthropic keeps a cached prompt prefix for 5 minutes from the start of the last request that used
it (opencode sends its cache markers without a TTL, so that is the tier it gets). The first request
after that writes the whole conversation to the cache again, at 1.25x the input price instead of
0.05-0.1x for a read: on a 600k-token conversation about $1.40 on Sonnet, $2.90 on Opus, out of
plan usage on a subscription.

**Keeps it warm (server).** The plugin wraps the process's `fetch` once and records each Anthropic
Messages request the agent sends (the ones that carry tools; title, summary and compaction calls do
not count) as it goes on the wire, after the auth plugin has set its headers. At 90% of the TTL
(4.5 minutes) it sends that request again with `max_tokens: 1` and no stream, which reads the cached
prefix and restarts its clock for about 1/11 of what the rewrite would cost (1/24 on Opus 5.5). It
follows Pi's rule: a refresh goes out only while the expected saving, `0.15 x miss cost - refresh
cost` when idle (the next request is certain while a tool call is still running), is at least
`warm.minSavings` ($0.05), so small conversations are left alone; it stops 30 minutes after the
last real request, on the first refresh that misses or fails, on compaction, and never for subagent
sessions. A request with budget thinking (`thinking.type: "enabled"`) is not replayed, since the cap
would change the budget Anthropic keys the cache on; current Claude models use adaptive thinking.
Only Anthropic is warmed: OpenAI publishes no cache lifetime and holds entries for hours.

**Warns (server), and offers the ways through (TUI).** Before a prompt is persisted,
`chat.message` checks the session's clock. When the cache has expired, the selected model differs
from the one the conversation was cached for, or (providers without a TTL) the session has been
idle for `warn.idleMinutes`, and the re-cache would cost at least `warn.minCost` ($0.50 at API list
prices; `warn.minTokens` for models without prices), the prompt is held: the text goes back into
the prompt box, and the TUI half opens a dialog, Keep first so a reflexive Enter is safe:

```
Prompt cache miss. The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$1.38 at API prices).
  Keep the prompt                                          Leave it in the box; nothing is sent.
  Continue on Jev's summary in a new session (~1s, ~$0)    Jev picks what the 601k-token history still needs; the summary is written in code, no LLM reads the history.
  Compact first, then send (~$1.20)                        Summarize the 601k-token history once, uncached, and continue on the summary.
  Start fresh with this prompt                             A new session with the same agent and model; the history stays here.
  Send anyway (~$1.50)                                     Write the 601k-token history to the cache again.
  Send, and stop asking in this session                    Same as sending, and no more holds here.
```

- **Continue on Jev's summary** (when Jev is set up). opencode plugins cannot replace the
  compaction model call, so this is a new session instead: Jev sorts every message and tool call
  of the session into *verbatim* (requirements, decisions, exact values, open errors),
  *summarize*, or *drop*, judged against the held prompt, in batches of up to 120 with
  `compact.concurrency` requests in flight; the summary is written in code from its choices (the
  earlier compaction summary, your requests, the verbatim items, one-line notes for the rest, and
  the files read and modified), so it takes about a second and costs next to nothing. A session
  with the same agent and model is created, the TUI moves there, and the summary is sent followed
  by the held prompt. If Jev fails, nothing is sent and the reason is toasted; the prompt stays in
  the box.
- **Compact first** asks what the summary should do: opencode's default, *Focus on this prompt*
  (keep what the held prompt needs, drop the rest), or guidance you write. The guidance reaches
  opencode's compaction through the `experimental.session.compacting` hook; the prompt is sent once
  the compaction finishes. If it fails, the text stays in the box.
- **Start fresh** creates a session with the same agent and model, moves to it and sends the prompt
  there.
- **Send anyway** and **Send, and stop asking** authorise the send through the server half, which
  lets that text through once (or, muted, every prompt in the session).

The costs are from `core.choiceCosts`: sending re-writes the history at the cache-write price; a
compaction reads it once at the input price. Without the TUI half (`opencode run`, a TUI without
the plugin), a toast says what to do, and sending the same text again within `warn.confirmSeconds`
goes through.

While Jev is wanted but not set up (`jev.enabled` is true and there is no key), the question ends
with a tip: `Tip: set TYPESAFE_API_KEY (https://console.typesafe.ai/keys) for Jev, which continues
on a one-second summary for ~$0; "jev": { "enabled": false } in cache-guard.json hides this.`

The server half records the hold in the session's state file (`held`) and nudges the TUI with a
`tui.command.execute` of `cache-guard.held`, so the dialog opens at once; the TUI's 1 Hz tick is
the fallback. The TUI answers through small files next to the state file: `<session>.confirm.json`
(one authorised send, or mute) and `<session>.compact.json` (guidance for the next compaction).

**Shows the clock (TUI).** `cache 4:12` (time left), `cache cold`, or `cache cold?` (no TTL known,
long idle) to the right of the prompt, with `↻3` for refreshes since the last real request. The
server half writes each session's state to `~/.cache/opencode-cache-guard/<sessionID>.json`; the
TUI half reads it once a second. `log.txt` next to them records every recorded request, refresh and
hold.

A resumed session gets its clock from the last reply opencode stored, so the first prompt after a
long break is still held.

**Trims tool output (server, Jev).** Text results over 12k characters from `bash`, `grep`, `glob`,
`list`, `webfetch`, `websearch`, MCP and other plugin tools (over 50k from `read`) are trimmed in
`tool.execute.after`, before the model sees them, so the prompt cache is never disturbed. Jev reads
the agent's current step (the latest request and what the assistant said since, from the session's
messages) and the output, split into at most 150 blocks, and says which blocks hold what the agent
needs: errors, failures, warnings, requested values, results. The kept blocks plus the first 5 and
last 20 lines stay, in order, with `[… N lines omitted …]` markers, and a footer points at the full
output saved under `~/.local/share/opencode/cache-guard/tool-output/<session>/<call>.txt`, to read
with `offset`/`limit`.

Output too large for one Jev request is pre-filtered in code first (head, tail, every line that
looks like an error with two lines of context, and an even sample). Nothing is trimmed when Jev
thinks the agent wants the whole output, when more than 70% would be kept, when the same call was
already trimmed this turn (asking again returns everything), or when Jev is unavailable, fails or
takes over `jev.timeoutMs` (2.5 s). `edit`, `write`, `apply_patch`, `task`, `todowrite`, `skill`,
`question` and `lsp` output is never trimmed.

opencode itself cuts tool output at 2,000 lines or 50 KB, keeps only a head or tail preview, and
saves the whole output under `~/.local/share/opencode/tool-output`. When it did, the plugin reads
that file back (up to 8 MB) and lets Jev pick from all of it, so an error in the cut middle still
reaches the agent; if the trim of the whole output is no smaller than opencode's preview, the
preview stays.

Each decision is logged under the `cache-guard` service (`opencode run --print-logs`) and in
`log.txt`, and a toast shows when output was trimmed (`"trim": { "toast": false }`, an
opencode-only key, turns the toast off).

**Compact first with Jev (server).** When Jev is set up and `compact.filter` is true, the
`experimental.session.compacting` hook (the one that carries the dialog's guidance) also asks Jev
which messages and tool calls must survive word for word, judged against the guidance when there
is one and the last two user messages otherwise, and appends them to the compaction prompt after
one sentence telling the summarizer to carry them over verbatim. This runs for every compaction
(`/compact` and automatic ones too), bounded by `compact.timeoutMs` per Jev request; on any
failure nothing is added and opencode compacts as it always does. Plugins cannot filter what the
summarizer reads, so the dropped items still reach it.

**Tells herdr (TUI).** Inside a [herdr](https://herdr.dev) pane it reports the pane token `cache`
for the session on screen: `cold 601k` (or `cold? 180k` for a guess from idle time) while the next
prompt would re-cache at least the warning threshold, and clears it while the cache is warm or
small, on the home screen, and when the TUI exits. Show it in herdr's agents sidebar with a custom
token in `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", { token = "$cache", fg = "#5f87d7", rules = [{ starts_with = "cold?", dim = true }] }]]
```

`src/herdr.ts` speaks herdr's socket protocol (`pane.report_metadata`, source `cache-guard`) and is
shared verbatim with the Codex port (pi-cache-guard goes through pi-herdr's event bus). `"herdr": { "enabled": false }` turns it off.
A model switch is not visible to the TUI, so the token only reflects time.

## Install

Both halves are in this package. In `opencode.jsonc`:

```jsonc
"plugin": ["opencode-cache-guard@github:justmytwospence/opencode-cache-guard#<commit>"]
```

and the same entry in `tui.jsonc`'s `plugin` list. Tested with opencode 1.18.29 and
`@ex-machina/opencode-anthropic-auth` 1.8.5 (a Claude subscription, whose zeroed catalog prices
the plugin replaces with list prices for its estimates).

## Setting up Jev

Jev runs through TypeSafe's own API: put a key from
[console.typesafe.ai/keys](https://console.typesafe.ai/keys) in opencode's environment as
`TYPESAFE_API_KEY` and restart opencode. Both halves read it: the server trims and marks what a
compaction must keep, the TUI writes the summary for the dialog's Jev option. `jev.provider` must
be empty or `typesafe` here (the gateways Pi's port knows are not reachable from a plugin); an
empty `jev.model` means `jev-latest`.

**cache-guard: Jev** in the command palette (also `/cache-guard-jev`) shows whether Jev is set up,
sends it one question and shows the latency (`Jev: typesafe/jev-latest, answered in 312 ms.`),
explains the key when it is missing, and turns Jev off or on. The choice is saved as `jev.enabled`
in `~/.config/opencode/cache-guard.json` (merged into the file; a file that is not a JSON object is
left alone and the error toasted) and applies to the next tool call and hold without a restart.
Off means no trimming, no Jev option, no compaction context and no tip.

## Settings

`~/.config/agents/cache-guard.json` (shared with the other ports), then
`~/.config/opencode/cache-guard.json`, then the plugin's options in `opencode.jsonc`
(`["opencode-cache-guard@...", { "trim": { "toast": false } }]`), then the project's
`.agents/cache-guard.json` and `.opencode/cache-guard.json`. Later layers win; objects merge. The
files are read again on each prompt, tool call and compaction, so edits apply without a restart.
The defaults of the keys this port reads:

```json
{
  "enabled": true,
  "warn": { "enabled": true, "minCost": 0.5, "minTokens": 100000, "confirmSeconds": 120, "idleMinutes": 180 },
  "warm": { "enabled": true, "continuationProbability": 0.15, "minSavings": 0.05, "idleMinutes": { "5m": 30, "1h": 120 } },
  "herdr": { "enabled": true },
  "jev": { "enabled": true, "provider": "", "model": "", "timeoutMs": 2500 },
  "trim": { "enabled": true, "minChars": 12000, "readMinChars": 50000, "maxBlocks": 150, "stateBudgetChars": 60000,
            "keepThreshold": 0.4, "needsAllThreshold": 0.6, "maxKeptShare": 0.7, "headLines": 5, "tailLines": 20 },
  "compact": { "filter": true, "timeoutMs": 10000, "concurrency": 4 }
}
```

`jev.timeoutMs` bounds one trimming request; `compact.timeoutMs` one request of a Jev summary or
compaction context, with `compact.concurrency` in flight at once. `"enabled": false` turns
everything off, Jev included; `"jev": { "enabled": false }` only the Jev parts; `"trim":
{ "enabled": false }` only the trimming; `"compact": { "filter": false }` only the compaction
context. `trim.toast` (opencode-only) hides the toast after a trim. `warm.prompt` is for the ports
that warm by sending a message; opencode replays the request instead.

`OPENCODE_CACHE_GUARD_WARM_DELAY_MS` overrides the refresh delay and `OPENCODE_CACHE_GUARD_TTL_MS` the Anthropic TTL (for testing).

## Limits

- The clock is the API's guaranteed minimum, measured from each request's start; entries are deleted
  soon after it, not exactly at it. Tool or system prompt changes, an MCP server reconnecting, and
  the date rolling over in opencode's system prompt also miss, and the clock cannot see them.
- A refresh reuses the recorded OAuth token; once the auth plugin has refreshed it (about every 8
  hours), a refresh gets 401 and warming stops until the next real request.
- A held prompt's text is put back and resent; attached files and images are not. The hold is a
  thrown error, which opencode also writes to its own log as an unexpected server error.
- The dialog's choices resend the prompt through the API with the held agent, model and variant,
  not through the prompt box, so `@file` references and pasted attachments are sent as plain text.
- Warming replays the exact request through the original `fetch`, so a proxy configured with
  `ANTHROPIC_BASE_URL` is used as well.
- A Jev summary is assembled, not written: the requests, the items Jev kept word for word and a
  line for the rest. It opens a new session as the first text part of the held prompt's message,
  so it shows in the transcript; opencode's own summary reads better when the history needs
  explaining.
- The TUI half needs `TYPESAFE_API_KEY` in its own environment for the Jev option; with `opencode
  attach` to a server started elsewhere, set it for the TUI too.
- The compaction context cannot stop the summarizer from reading the dropped items; it only adds
  what must survive. Jev's answers are not recorded in the session (opencode has no custom
  entries); they are in `log.txt`.

## Development

```sh
npm ci && npm run check   # typecheck and unit tests; nothing calls the live API
# In a scratch project: .opencode/opencode.jsonc and .opencode/tui.jsonc with
#   { "plugin": ["file:///path/to/opencode-cache-guard"] }
```

To try a local checkout in place of the pin: opencode dedupes plugins by package name and the
later config wins, so

```sh
printf '{"plugin":["opencode-cache-guard@file:'"$PWD"'"]}' > /tmp/try.json
OPENCODE_CONFIG=/tmp/try.json opencode
```

links this checkout instead of the pinned commit.
