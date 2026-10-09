// Jev, TypeSafe's judgment model, over its own HTTP API (System One,
// https://docs.typesafe.ai/api.md), with `TYPESAFE_API_KEY` from the environment. `lean.ts` speaks
// Pi's classifier shapes, so `bool` questions go out as the API's `noul` type and its `noul`
// answers come back as `{ type: "bool", probability }`. Never throws: every failure is
// `{ ok: false, reason }`.
import type { Answer, Question } from "./lean.js";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
/** The only provider this port reaches Jev through; Pi's port also knows the gateways. */
export const PROVIDER = "typesafe";

export interface JevTarget {
  provider: string;
  model: string;
}

export const label = (t: JevTarget) => `${t.provider}/${t.model}`;

export type JevState =
  | { kind: "ready"; target: JevTarget }
  | { kind: "missing"; reason: string }
  | { kind: "off" };

/**
 * Whether Jev can be used: the settings allow it, `jev.provider` is empty or `typesafe` (nothing
 * else is reachable from here), and the key is in the environment.
 */
export function resolveJev(settings: { enabled: boolean; jev: { enabled: boolean; provider: string; model: string } }, env: NodeJS.ProcessEnv = process.env): JevState {
  if (!settings.enabled || !settings.jev.enabled) return { kind: "off" };
  const provider = settings.jev.provider.trim();
  if (provider && provider !== PROVIDER) {
    return { kind: "missing", reason: `jev.provider "${provider}" is not supported here (only TypeSafe's API, "typesafe" or "")` };
  }
  if (!env.TYPESAFE_API_KEY?.trim()) return { kind: "missing", reason: "TYPESAFE_API_KEY is not set" };
  return { kind: "ready", target: { provider: PROVIDER, model: settings.jev.model.trim() || DEFAULT_MODEL } };
}

/** The API's question types: `noul` where lean.ts says `bool`. */
export type ApiQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: readonly string[] };

export type ApiAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number };

export function toApiQuestion(question: Question): ApiQuestion {
  return question.type === "bool" ? { type: "noul", instructions: question.instructions, criteria: question.criteria } : question;
}

export function toApiQuestions(questions: Record<string, Question>): Record<string, ApiQuestion> {
  return Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toApiQuestion(q)]));
}

/** An API answer as lean.ts reads it; undefined for a shape it does not know. */
export function fromApiAnswer(answer: unknown): Answer | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const a = answer as Partial<ApiAnswer> & { probability?: unknown };
  if (a.type === "noul") {
    const probability = typeof a.noul === "number" ? a.noul : typeof a.probability === "number" ? a.probability : undefined;
    return probability === undefined ? undefined : { type: "bool", probability };
  }
  if (a.type === "choice" && typeof a.choice === "string") {
    return { type: "choice", choice: a.choice, probabilities: a.probabilities ?? {}, confidence: typeof a.confidence === "number" ? a.confidence : 0 };
  }
  if (a.type === "score" && typeof a.score === "number") return { type: "score", score: a.score, confidence: typeof a.confidence === "number" ? a.confidence : 0 };
  return undefined;
}

export function fromApiAnswers(answers: Record<string, unknown>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [id, raw] of Object.entries(answers)) {
    const answer = fromApiAnswer(raw);
    if (answer) out[id] = answer;
  }
  return out;
}

export interface JevOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export type JevOutcome =
  | { ok: true; answers: Record<string, Answer>; model: string; latencyMs: number; inputTokens?: number }
  | { ok: false; reason: string };

/** The function the trimming and compaction code asks Jev through: one request, one outcome. */
export type Ask = (state: Record<string, unknown>, questions: Record<string, Question>) => Promise<JevOutcome>;

/** Ask Jev one request. Never throws: every failure is `{ ok: false, reason }`. */
export async function askJev(state: unknown, questions: Record<string, Question>, options: JevOptions = {}): Promise<JevOutcome> {
  const apiKey = (options.apiKey ?? process.env.TYPESAFE_API_KEY)?.trim();
  if (!apiKey) return { ok: false, reason: "TYPESAFE_API_KEY is not set" };
  const started = Date.now();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 2_500);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: options.model || DEFAULT_MODEL, state, questions: toApiQuestions(questions) }),
      signal,
    });
  } catch (error) {
    if (timeout.aborted) return { ok: false, reason: "timed out" };
    if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
    return { ok: false, reason: (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 160) || "unknown error" };
  }
  if (!response.ok) return { ok: false, reason: response.status === 401 ? "invalid API key" : `HTTP ${response.status}` };
  let body: { model?: string; answers?: Record<string, unknown>; usage?: { input_tokens?: number } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, reason: "unreadable response" };
  }
  if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") return { ok: false, reason: "response without answers" };
  return {
    ok: true,
    answers: fromApiAnswers(body.answers),
    model: typeof body.model === "string" ? body.model : "",
    latencyMs: Date.now() - started,
    ...(typeof body.usage?.input_tokens === "number" ? { inputTokens: body.usage.input_tokens } : {}),
  };
}

/** A one-question request, to check that Jev answers with the key in the environment. */
export function probe(options: JevOptions = {}): Promise<JevOutcome> {
  return askJev({ message: "The tests pass now, thanks." }, {
    approved: { type: "bool", instructions: "Is the user satisfied?", criteria: { true: "Satisfied", false: "Not satisfied" } },
  }, { timeoutMs: 10_000, ...options });
}
