// What the TUI slot shows for a session's cache state. Kept free of JSX so tests can import it.
import { readFileSync } from "node:fs";
import path from "node:path";

import { type Settings, formatClock } from "./core.js";
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
