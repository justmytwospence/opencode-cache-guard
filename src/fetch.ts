// The global fetch wrapper: sees every Anthropic Messages request as it goes on the wire (after
// the auth plugin has set its OAuth headers and rewritten the body), records the ones that carry
// tools (the agent's own requests; title, summary and compaction calls carry none) with the session
// they belong to, and can send one again later with a one-token output cap to refresh its cache.

/** Set by the `chat.headers` hook so the wrapper can tell which session a request belongs to. */
export const SESSION_HEADER = "x-opencode-cache-guard-session";

export interface RecordedRequest {
  url: string;
  /** The final request headers, lowercase names. Holds the authorization token: never persist. */
  headers: Record<string, string>;
  body: string;
  sentAt: number;
  sessionID?: string;
  /** Which header named the session. */
  sessionVia?: "guard-header" | "x-session-id";
}

type FetchFn = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFn>[0];
type FetchInit = Parameters<FetchFn>[1];

function urlOf(input: FetchInput): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof input === "object" && input && "url" in input && typeof input.url === "string") return input.url;
  return undefined;
}

function methodOf(input: FetchInput, init: FetchInit): string {
  const method = init?.method ?? (typeof input === "object" && input && "method" in input ? input.method : undefined);
  return (method ?? "GET").toUpperCase();
}

/** `/v1/messages` on any host (the auth plugin may point it at ANTHROPIC_BASE_URL). */
export function isAnthropicMessages(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/v1/messages");
  } catch {
    return false;
  }
}

/** The request's headers merged the way fetch does: the Request's own, then `init.headers` on top. */
export function mergeHeaders(input: FetchInput, init: FetchInit): Headers {
  const headers = new Headers();
  if (typeof input === "object" && input && "headers" in input) {
    new Headers(input.headers as HeadersInit).forEach((value, key) => headers.set(key, value));
  }
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

async function bodyOf(input: FetchInput, init: FetchInit): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body !== undefined && init.body !== null) return undefined;
  if (typeof input === "object" && input && "clone" in input && typeof input.clone === "function") {
    try {
      return await (input as Request).clone().text();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export interface Inspection {
  record?: RecordedRequest;
  /** The call to forward, with the session header removed. */
  input: FetchInput;
  init: FetchInit;
}

/**
 * Looks at one fetch call. An Anthropic Messages POST whose JSON body has tools is recorded; the
 * session header, when present, names its session and is stripped before the call goes on.
 */
export async function inspect(input: FetchInput, init: FetchInit, now: number): Promise<Inspection> {
  const url = urlOf(input);
  if (!url || methodOf(input, init) !== "POST" || !isAnthropicMessages(url)) return { input, init };
  const headers = mergeHeaders(input, init);
  const guard = headers.get(SESSION_HEADER);
  const sessionID = guard ?? headers.get("x-session-id") ?? undefined;
  const sessionVia = guard ? "guard-header" : sessionID ? "x-session-id" : undefined;
  // Read the body before rebuilding a Request: the rebuild takes the original's body stream.
  const body = await bodyOf(input, init);
  let forwardInput = input;
  let forwardInit = init;
  if (headers.has(SESSION_HEADER)) {
    headers.delete(SESSION_HEADER);
    if (typeof input === "object" && input && "headers" in input && !init?.headers) {
      forwardInput = new Request(input as Request, { headers });
    } else {
      forwardInit = { ...init, headers };
    }
  }
  if (!body) return { input: forwardInput, init: forwardInit };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { input: forwardInput, init: forwardInit };
  }
  const tools = (parsed as { tools?: unknown })?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return { input: forwardInput, init: forwardInit };
  return {
    record: { url, headers: headersToObject(headers), body, sentAt: now, sessionID, sessionVia },
    input: forwardInput,
    init: forwardInit,
  };
}

/** What a recorded request looks like sent again for its cache alone: one output token, no stream. */
export function replayRequest(record: RecordedRequest): { url: string; init: RequestInit } | { refused: string } {
  const body = JSON.parse(record.body) as Record<string, unknown>;
  const thinking = body.thinking as { type?: string } | undefined;
  // Budget thinking derives its budget from max_tokens, and Anthropic keys the message cache on
  // the thinking config, so a capped replay would miss and write a second entry.
  if (thinking?.type === "enabled") return { refused: "budget thinking" };
  const headers: Record<string, string> = { ...record.headers, accept: "application/json" };
  delete headers["content-length"];
  return {
    url: record.url,
    init: { method: "POST", headers, body: JSON.stringify({ ...body, max_tokens: 1, stream: false }) },
  };
}

export interface ReplayUsage {
  promptTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The usage block of a Messages response, as the cache saw it. */
export function parseUsage(json: unknown): ReplayUsage | undefined {
  const usage = (json as { usage?: Record<string, unknown> })?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const cacheRead = n("cache_read_input_tokens");
  const cacheWrite = n("cache_creation_input_tokens");
  return { promptTokens: n("input_tokens") + cacheRead + cacheWrite, cacheRead, cacheWrite };
}

let installed: { original: FetchFn; wrapped: FetchFn } | undefined;

/**
 * Replaces `globalThis.fetch` with a wrapper that reports recorded requests to `onRecord`. Installed
 * once per process; `uninstall` restores the original fetch when the wrapper is still in place.
 * Returns the original fetch, which replays go through directly.
 */
export function install(onRecord: (record: RecordedRequest) => void, now: () => number = Date.now): FetchFn {
  if (installed) return installed.original;
  const original = globalThis.fetch;
  const wrapped: FetchFn = async (input, init) => {
    let forward: Inspection = { input, init };
    try {
      forward = await inspect(input, init, now());
      if (forward.record) onRecord(forward.record);
    } catch {
      // Inspection must never break a request.
    }
    return original(forward.input, forward.init);
  };
  globalThis.fetch = wrapped;
  installed = { original, wrapped };
  return original;
}

export function uninstall(): void {
  if (!installed) return;
  if (globalThis.fetch === installed.wrapped) globalThis.fetch = installed.original;
  installed = undefined;
}
