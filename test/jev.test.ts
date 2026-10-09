import { expect, test, vi } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.js";
import { ENDPOINT, askJev, fromApiAnswer, fromApiAnswers, probe, resolveJev, toApiQuestions } from "../src/jev.js";
import type { Question } from "../src/lean.js";

const questions: Record<string, Question> = {
  needs_all: { type: "bool", instructions: "All of it?", criteria: { true: "yes", false: "no" } },
  keep: { type: "choice", instructions: "How?", criteria: { verbatim: "v", drop: "d" } },
  quality: { type: "score", instructions: "How good?", criteria: ["bad", "ok", "good"] },
};

test("bool questions go out as noul; the other types pass through", () => {
  const api = toApiQuestions(questions);
  expect(api.needs_all).toEqual({ type: "noul", instructions: "All of it?", criteria: { true: "yes", false: "no" } });
  expect(api.keep).toEqual(questions.keep);
  expect(api.quality).toEqual(questions.quality);
});

test("noul answers come back as bool probabilities; unknown shapes are dropped", () => {
  expect(fromApiAnswer({ type: "noul", noul: 0.83 })).toEqual({ type: "bool", probability: 0.83 });
  expect(fromApiAnswer({ type: "noul", probability: 0.2 })).toEqual({ type: "bool", probability: 0.2 });
  expect(fromApiAnswer({ type: "choice", choice: "drop", probabilities: { drop: 0.9 }, confidence: 0.9 })).toEqual({ type: "choice", choice: "drop", probabilities: { drop: 0.9 }, confidence: 0.9 });
  expect(fromApiAnswer({ type: "score", score: 2, confidence: 0.5 })).toEqual({ type: "score", score: 2, confidence: 0.5 });
  expect(fromApiAnswer({ type: "noul" })).toBeUndefined();
  expect(fromApiAnswer({ type: "bool", probability: 1 })).toBeUndefined();
  expect(fromApiAnswer("x")).toBeUndefined();
  expect(fromApiAnswers({ a: { type: "noul", noul: 1 }, b: null })).toEqual({ a: { type: "bool", probability: 1 } });
});

function fetching(respond: (body: any, init: RequestInit) => Response | Error) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, init, body });
    const result = respond(body, init);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("askJev sends the translated questions with the key and reads the answers back", async () => {
  const { fetchImpl, calls } = fetching(() => new Response(JSON.stringify({ model: "jev-1.13", answers: { needs_all: { type: "noul", noul: 0.1 }, keep: { type: "choice", choice: "verbatim", probabilities: {}, confidence: 1 } }, usage: { input_tokens: 123 } })));
  const outcome = await askJev({ a: 1 }, questions, { apiKey: "k", model: "jev-latest", timeoutMs: 1_000, fetch: fetchImpl });
  expect(outcome).toEqual({ ok: true, model: "jev-1.13", latencyMs: expect.any(Number), inputTokens: 123, answers: { needs_all: { type: "bool", probability: 0.1 }, keep: { type: "choice", choice: "verbatim", probabilities: {}, confidence: 1 } } });
  expect(calls[0]!.url).toBe(ENDPOINT);
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer k");
  expect(calls[0]!.body).toEqual({ model: "jev-latest", state: { a: 1 }, questions: toApiQuestions(questions) });
  // An empty model means jev-latest; the environment's key is used when none is given.
  const env = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "from-env";
  await askJev({}, questions, { model: "", fetch: fetchImpl });
  expect(calls[1]!.body.model).toBe("jev-latest");
  expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer from-env");
  process.env.TYPESAFE_API_KEY = env;
});

test("askJev never throws: every failure is a reason", async () => {
  const noKey = await askJev({}, questions, { apiKey: "", fetch: fetching(() => new Response("{}")).fetchImpl });
  expect(noKey).toEqual({ ok: false, reason: "TYPESAFE_API_KEY is not set" });
  expect(await askJev({}, questions, { apiKey: "k", fetch: fetching(() => new Response("no", { status: 401 })).fetchImpl })).toEqual({ ok: false, reason: "invalid API key" });
  expect(await askJev({}, questions, { apiKey: "k", fetch: fetching(() => new Response("boom", { status: 500 })).fetchImpl })).toEqual({ ok: false, reason: "HTTP 500" });
  expect(await askJev({}, questions, { apiKey: "k", fetch: fetching(() => new Error("socket hang up")).fetchImpl })).toEqual({ ok: false, reason: "socket hang up" });
  expect(await askJev({}, questions, { apiKey: "k", fetch: fetching(() => new Response("not json")).fetchImpl })).toEqual({ ok: false, reason: "unreadable response" });
  expect(await askJev({}, questions, { apiKey: "k", fetch: fetching(() => new Response(JSON.stringify({ model: "x" }))).fetchImpl })).toEqual({ ok: false, reason: "response without answers" });
  const slow = (async (_url: string, init: RequestInit) => {
    await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    return new Response("{}");
  }) as unknown as typeof fetch;
  expect(await askJev({}, questions, { apiKey: "k", timeoutMs: 20, fetch: slow })).toEqual({ ok: false, reason: "timed out" });
  const controller = new AbortController();
  const cancelled = askJev({}, questions, { apiKey: "k", timeoutMs: 10_000, signal: controller.signal, fetch: slow });
  controller.abort();
  expect(await cancelled).toEqual({ ok: false, reason: "cancelled" });
});

test("resolveJev: off by settings, missing without a key or with another provider, else TypeSafe's API", () => {
  const env = { TYPESAFE_API_KEY: "k" };
  expect(resolveJev(DEFAULT_SETTINGS, env)).toEqual({ kind: "ready", target: { provider: "typesafe", model: "jev-latest" } });
  expect(resolveJev(mergeSettings(DEFAULT_SETTINGS, ['{"jev":{"provider":"typesafe","model":"jev-1.13"}}']), env)).toEqual({ kind: "ready", target: { provider: "typesafe", model: "jev-1.13" } });
  expect(resolveJev(DEFAULT_SETTINGS, {})).toEqual({ kind: "missing", reason: "TYPESAFE_API_KEY is not set" });
  expect(resolveJev(DEFAULT_SETTINGS, { TYPESAFE_API_KEY: "  " })).toEqual({ kind: "missing", reason: "TYPESAFE_API_KEY is not set" });
  expect(resolveJev(mergeSettings(DEFAULT_SETTINGS, ['{"jev":{"provider":"openrouter"}}']), env)).toMatchObject({ kind: "missing", reason: expect.stringContaining('jev.provider "openrouter" is not supported here') });
  expect(resolveJev(mergeSettings(DEFAULT_SETTINGS, ['{"jev":{"enabled":false}}']), env)).toEqual({ kind: "off" });
  expect(resolveJev(mergeSettings(DEFAULT_SETTINGS, ['{"enabled":false}']), env)).toEqual({ kind: "off" });
});

test("probe asks one bool question", async () => {
  const { fetchImpl, calls } = fetching(() => new Response(JSON.stringify({ answers: { approved: { type: "noul", noul: 0.95 } } })));
  const outcome = await probe({ apiKey: "k", fetch: fetchImpl });
  expect(outcome.ok && outcome.answers.approved).toEqual({ type: "bool", probability: 0.95 });
  expect(calls[0]!.body.questions.approved.type).toBe("noul");
});
