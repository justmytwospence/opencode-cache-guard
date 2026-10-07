// Per-session cache state and the keep-warm schedule. One timer per session, armed at 90% of the
// TTL after each recorded request; when it fires, Pi's rule decides whether the refresh is worth
// its read, and the recorded request goes out again with a one-token output cap.
import {
  type Price,
  type Settings,
  decideWarm,
  tier,
  warmCost,
  warmDeadline,
  warmDelayMs,
} from "./core.js";
import { type RecordedRequest, type ReplayUsage, parseUsage, replayRequest } from "./fetch.js";

export const ANTHROPIC_TTL_MS = 5 * 60_000;
/** A replay counts as a hit when the cache served at least this share of the prompt. */
const HIT_SHARE = 0.8;

export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** What the TUI reads: everything about a session's cache except the request itself. */
export interface SessionSnapshot {
  sessionID: string;
  /** When the cache entry was last read or written (a real request or a refresh that hit). */
  lastAt: number;
  /** When the last real request started. */
  lastRealAt: number;
  /** The provider's cache lifetime; absent for providers that publish none. */
  ttlMs?: number;
  /** Prompt tokens the next request re-sends. */
  tokens: number;
  model?: ModelRef;
  /** Whether a refresh is scheduled or in flight. */
  warming: boolean;
  /** Refreshes that hit since the last real request. */
  warms: number;
  lastWarmCost?: number;
  /** Why warming stopped, once it has. */
  stopReason?: string;
  /** The model's prices per million tokens, so the TUI can price a miss. */
  price?: Price;
  updatedAt: number;
}

export interface SessionState extends SessionSnapshot {
  request?: RecordedRequest;
  busy: boolean;
  child: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface WarmerDeps {
  settings: () => Settings;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  log?: (line: string) => void;
  onChange?: (snapshot: SessionSnapshot) => void;
  /** Overrides the refresh delay (testing). */
  delayMs?: number;
}

export function snapshotOf(state: SessionState): SessionSnapshot {
  const { request: _request, busy: _busy, child: _child, timer: _timer, ...snapshot } = state;
  return snapshot;
}

export class Warmer {
  readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;

  constructor(private readonly deps: WarmerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get(sessionID: string): SessionState {
    let state = this.sessions.get(sessionID);
    if (!state) {
      state = { sessionID, lastAt: 0, lastRealAt: 0, tokens: 0, warming: false, warms: 0, updatedAt: this.now(), busy: false, child: false };
      this.sessions.set(sessionID, state);
    }
    return state;
  }

  /** The model and price the session's next request uses (from `chat.params`). */
  setModel(sessionID: string, model: ModelRef, price: Price | undefined, ttlMs: number | undefined): void {
    const state = this.get(sessionID);
    state.model = model;
    state.price = price;
    state.ttlMs = ttlMs;
    this.changed(state);
  }

  /** A real request went out for the session: the cache clock restarts, and so does the schedule. */
  recordRequest(sessionID: string, record: RecordedRequest): void {
    const state = this.get(sessionID);
    state.request = record;
    state.lastAt = state.lastRealAt = record.sentAt;
    state.warms = 0;
    state.lastWarmCost = undefined;
    state.stopReason = undefined;
    this.schedule(state);
  }

  /**
   * The last request's prompt and reply size, from the assistant message's usage. For a provider
   * whose requests are not recorded (no Anthropic wire), the message's start is the clock too.
   */
  recordTokens(sessionID: string, tokens: number, model?: ModelRef, startedAt?: number): void {
    const state = this.get(sessionID);
    let changed = false;
    if (!state.request && startedAt && startedAt > state.lastAt) {
      state.lastAt = state.lastRealAt = startedAt;
      changed = true;
    }
    if (tokens > 0 && (tokens !== state.tokens || (model && !sameModel(model, state.model)))) {
      state.tokens = tokens;
      if (model) state.model = model;
      changed = true;
    }
    if (changed) this.changed(state);
  }

  /** A session this process has not seen a request for: its clock from its last recorded reply. */
  restore(sessionID: string, last: { at: number; tokens: number; model: ModelRef; ttlMs?: number; price?: Price }): SessionState {
    const state = this.get(sessionID);
    if (state.request || last.at <= state.lastAt) return state;
    state.lastAt = state.lastRealAt = last.at;
    state.tokens = last.tokens;
    state.model = last.model;
    state.ttlMs = last.ttlMs;
    state.price = last.price;
    this.changed(state);
    return state;
  }

  setBusy(sessionID: string, busy: boolean): void {
    this.get(sessionID).busy = busy;
  }

  /** Subagent sessions end with their parent's tool call; nobody continues them, so never warm them. */
  setChild(sessionID: string, child: boolean): void {
    const state = this.get(sessionID);
    state.child = child;
    if (child) this.stop(state, "subagent session");
  }

  /** The context was replaced (compaction): there is no cache to keep. */
  reset(sessionID: string): void {
    const state = this.sessions.get(sessionID);
    if (!state) return;
    this.stop(state, "context compacted");
    state.request = undefined;
    state.lastAt = state.lastRealAt = 0;
    state.tokens = 0;
    this.changed(state);
  }

  dispose(): void {
    for (const state of this.sessions.values()) this.clearTimer(state);
    this.sessions.clear();
  }

  private schedule(state: SessionState): void {
    this.clearTimer(state);
    const settings = this.deps.settings();
    const ttlMs = state.ttlMs ?? ANTHROPIC_TTL_MS;
    const delay = this.deps.delayMs ?? warmDelayMs(ttlMs);
    if (!settings.enabled || !settings.warm.enabled) return this.stop(state, "warming disabled");
    if (state.child) return this.stop(state, "subagent session");
    if (!state.request || delay === undefined) return this.stop(state, "nothing to replay");
    const at = state.lastAt + delay;
    if (at > warmDeadline(state.lastRealAt, ttlMs, settings)) {
      return this.stop(state, `${settings.warm.idleMinutes[tier(ttlMs)]}-minute idle limit reached`);
    }
    state.warming = true;
    state.timer = setTimeout(() => void this.refresh(state), Math.max(0, at - this.now()));
    state.timer.unref?.();
    this.changed(state);
  }

  async refresh(state: SessionState): Promise<void> {
    state.timer = undefined;
    const settings = this.deps.settings();
    const ttlMs = state.ttlMs ?? ANTHROPIC_TTL_MS;
    const request = state.request;
    if (!request) return this.stop(state, "nothing to replay");
    if (!state.price) return this.stop(state, "cache economics unavailable");
    if (state.tokens <= 0) return this.stop(state, "prompt size unknown");
    // A long tool call keeps the agent busy without a request; the next step is certain, so the
    // refresh is worth more than while idle. A request already streaming makes it a harmless read.
    const decision = decideWarm(state.tokens, state.price, ttlMs, !state.busy, settings);
    if (decision.action === "stop") {
      return this.stop(state, `expected saving $${decision.expectedSavings.toFixed(3)} below $${settings.warm.minSavings.toFixed(2)}`);
    }
    const replay = replayRequest(request);
    if ("refused" in replay) return this.stop(state, `request cannot be replayed (${replay.refused})`);
    const startedAt = this.now();
    let usage: ReplayUsage | undefined;
    let status = 0;
    try {
      const response = await this.deps.fetch(replay.url, replay.init);
      status = response.status;
      const json: unknown = await response.json().catch(() => undefined);
      usage = response.ok ? parseUsage(json) : undefined;
      if (!response.ok) {
        const detail = (json as { error?: { message?: string } })?.error?.message ?? "";
        this.log(`${state.sessionID} refresh failed: HTTP ${status} ${detail}`.trim());
      }
    } catch (error) {
      this.log(`${state.sessionID} refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.sessions.get(state.sessionID) !== state) return;
    if (!usage) return this.stop(state, status ? `refresh failed (HTTP ${status})` : "refresh failed");
    if (usage.cacheRead < HIT_SHARE * usage.promptTokens) {
      this.log(`${state.sessionID} refresh missed: read ${usage.cacheRead} of ${usage.promptTokens} prompt tokens (wrote ${usage.cacheWrite})`);
      return this.stop(state, "refresh missed the cache");
    }
    state.lastAt = startedAt;
    state.warms += 1;
    state.lastWarmCost = warmCost(usage.promptTokens, state.price);
    this.log(`${state.sessionID} refreshed: read ${usage.cacheRead} of ${usage.promptTokens} prompt tokens, ~$${state.lastWarmCost.toFixed(4)}`);
    this.schedule(state);
  }

  private stop(state: SessionState, reason: string): void {
    this.clearTimer(state);
    const was = state.warming;
    state.warming = false;
    state.stopReason = reason;
    if (was) this.log(`${state.sessionID} warming stopped: ${reason}`);
    this.changed(state);
  }

  private clearTimer(state: SessionState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
  }

  private changed(state: SessionState): void {
    state.updatedAt = this.now();
    this.deps.onChange?.(snapshotOf(state));
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}

export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID;
}
