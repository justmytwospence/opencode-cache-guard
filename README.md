# opencode-cache-guard

An [opencode](https://opencode.ai) plugin that keeps the Anthropic prompt cache warm between
turns, asks before a prompt that would re-cache a large conversation, and shows how long the cache
has left beside the prompt. The opencode port of
[pi-cache-guard](https://github.com/justmytwospence/pi-cache-guard); `src/core.ts` (the cache
clock, the cost of a miss, when a refresh or a warning pays) and the settings file are shared with
it and with [claude-cache-guard](https://github.com/justmytwospence/claude-cache-guard) and
[codex-cache-guard](https://github.com/justmytwospence/codex-cache-guard).

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

**Warns (server).** Before a prompt is persisted, `chat.message` checks the session's clock. When
the cache has expired, the selected model differs from the one the conversation was cached for, or
(providers without a TTL) the session has been idle for `warn.idleMinutes`, and the re-cache would
cost at least `warn.minCost` ($0.50 at API list prices; `warn.minTokens` for models without
prices), the prompt is held: a toast explains,

```
Prompt cache miss
The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$1.38 at API prices).
Press Enter again within 2 min to send it anyway; /compact or /new first is cheaper.
```

the text goes back into the prompt box, and the TUI's own "Failed to send prompt" toast names the
hold. Sending the same text again within `warn.confirmSeconds` goes through. opencode's plugin API
has no way to ask, so holding once is the closest thing to a confirm dialog.

**Shows the clock (TUI).** `cache 4:12` (time left), `cache cold`, or `cache cold?` (no TTL known,
long idle) to the right of the prompt, with `↻3` for refreshes since the last real request. The
server half writes each session's state to `~/.cache/opencode-cache-guard/<sessionID>.json`; the
TUI half reads it once a second. `log.txt` next to them records every recorded request, refresh and
hold.

A resumed session gets its clock from the last reply opencode stored, so the first prompt after a
long break is still held.

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
shared verbatim with pi-cache-guard and the Codex port. `"herdr": { "enabled": false }` turns it off.
A model switch is not visible to the TUI, so the token only reflects time.

## Install

Both halves are in this package. In `opencode.jsonc`:

```jsonc
"plugin": ["opencode-cache-guard@github:justmytwospence/opencode-cache-guard#<commit>"]
```

and the same entry in `tui.jsonc`'s `plugin` list. Tested with opencode 1.18.29 and
`@ex-machina/opencode-anthropic-auth` 1.8.5 (a Claude subscription, whose zeroed catalog prices
the plugin replaces with list prices for its estimates).

## Settings

`~/.config/agents/cache-guard.json` (shared with the other ports), then
`~/.config/opencode/cache-guard.json`, then the project's `.agents/cache-guard.json` and
`.opencode/cache-guard.json`. Later files win; objects merge. The defaults:

```json
{
  "enabled": true,
  "warn": { "enabled": true, "minCost": 0.5, "minTokens": 100000, "confirmSeconds": 120, "idleMinutes": 180 },
  "warm": { "enabled": true, "continuationProbability": 0.15, "minSavings": 0.05, "idleMinutes": { "5m": 30, "1h": 120 } },
  "herdr": { "enabled": true }
}
```

`OPENCODE_CACHE_GUARD_WARM_DELAY_MS` overrides the refresh delay (for testing).

## Limits

- The clock is the API's guaranteed minimum, measured from each request's start; entries are deleted
  soon after it, not exactly at it. Tool or system prompt changes, an MCP server reconnecting, and
  the date rolling over in opencode's system prompt also miss, and the clock cannot see them.
- A refresh reuses the recorded OAuth token; once the auth plugin has refreshed it (about every 8
  hours), a refresh gets 401 and warming stops until the next real request.
- A held prompt's text is put back; attached files and images are not. The hold is a thrown error,
  which opencode also writes to its own log as an unexpected server error.
- Warming replays the exact request through the original `fetch`, so a proxy configured with
  `ANTHROPIC_BASE_URL` is used as well.

## Development

```sh
npm ci && npm run check
# In a scratch project: .opencode/opencode.jsonc and .opencode/tui.jsonc with
#   { "plugin": ["file:///path/to/opencode-cache-guard"] }
```
