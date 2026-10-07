// What the TUI slot shows for a session's cache state. Kept free of JSX so tests can import it.
import { readFileSync } from "node:fs";
import path from "node:path";

import { type ColdReason, type Settings, formatClock, herdrCacheValue, missCost } from "./core.js";
import type { SessionSnapshot } from "./warmer.js";

export interface View {
  /** "4:12" while warm. */
  left?: string;
  /** "cold" once the next request misses; "cold?" when no TTL is known and the idle limit passed. */
  cold?: string;
  warms: number;
}

/** What the slot shows for a session's state at `now`; undefined keeps the slot empty. */
export function view(snapshot: SessionSnapshot | undefined, now: number, settings: Settings): View | undefined {
  if (!snapshot || !snapshot.lastAt || !snapshot.tokens) return undefined;
  const idleMs = Math.max(0, now - snapshot.lastAt);
  if (snapshot.ttlMs === undefined) {
    return idleMs >= settings.warn.idleMinutes * 60_000 ? { cold: "cold?", warms: snapshot.warms } : undefined;
  }
  const left = snapshot.lastAt + snapshot.ttlMs - now;
  return left > 0 ? { left: formatClock(left), warms: snapshot.warms } : { cold: "cold", warms: snapshot.warms };
}

export function readSnapshot(dir: string, sessionID: string): SessionSnapshot | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, `${sessionID}.json`), "utf8")) as SessionSnapshot;
  } catch {
    return undefined;
  }
}

/** Why the session's next request misses, from its snapshot alone (a model switch is not visible here). */
export function coldReasonOf(snapshot: SessionSnapshot | undefined, now: number, settings: Settings): ColdReason | undefined {
  if (!snapshot || !snapshot.lastAt || !snapshot.tokens) return undefined;
  const idleMs = Math.max(0, now - snapshot.lastAt);
  if (snapshot.ttlMs !== undefined) return idleMs > snapshot.ttlMs ? { kind: "expired", idleMs: idleMs - snapshot.ttlMs } : undefined;
  return idleMs >= settings.warn.idleMinutes * 60_000 ? { kind: "idle", idleMs } : undefined;
}

/** The herdr `cache` token for the session on screen: "cold 664k" while doomed, else undefined. */
export function herdrValue(snapshot: SessionSnapshot | undefined, now: number, settings: Settings): string | undefined {
  const reason = coldReasonOf(snapshot, now, settings);
  if (!reason || !snapshot) return undefined;
  const cost = snapshot.price ? missCost(snapshot.tokens, snapshot.price, snapshot.ttlMs ?? 5 * 60_000) : undefined;
  return herdrCacheValue(reason, snapshot.tokens, cost, settings);
}
