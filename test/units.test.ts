import { expect, test } from "vitest";

import { extractUnits, lastUserMessages, messageText, recentTexts } from "../src/units.js";
import { assistant, user } from "./messages.js";

test("messageText: text parts that are neither synthetic nor ignored", () => {
  expect(messageText({ info: { role: "user" }, parts: [{ type: "text", text: "a" }, { type: "text", text: "ctx", synthetic: true }, { type: "text", text: "old", ignored: true }, { type: "file" }, { type: "text", text: "b" }] })).toBe("a\nb");
});

test("extractUnits: user and assistant texts, tool calls with their output or error, and the files touched", () => {
  const { units, previousSummary, fileOps } = extractUnits([
    user("Use pnpm, never npm."),
    assistant(["Looking."], [
      { tool: "read", callID: "c1", input: { filePath: "src/a.ts" }, output: "contents" },
      { tool: "bash", callID: "c2", input: { command: "npm test" }, error: "exit 1" },
    ]),
    user("Now add a cache."),
    assistant([], [{ tool: "edit", callID: "c3", input: { filePath: "src/cache.ts", oldString: "", newString: "" }, output: "ok" }, { tool: "write", callID: "c4", input: { filePath: "src/new.ts", content: "" }, output: "ok" }]),
  ]);
  expect(units.map((u) => [u.id, u.kind, u.message])).toEqual([["U001", "user", 0], ["U002", "assistant", 1], ["U003", "tool", 1], ["U004", "tool", 1], ["U005", "user", 2], ["U006", "tool", 3], ["U007", "tool", 3]]);
  expect(units[0]!.text).toBe("Use pnpm, never npm.");
  expect(units[2]!.tool).toEqual({ name: "read", args: '{"filePath":"src/a.ts"}', result: "contents", isError: false, callId: "c1" });
  expect(units[2]!.text).toBe('read({"filePath":"src/a.ts"})\ncontents');
  expect(units[3]!.tool).toMatchObject({ name: "bash", result: "exit 1", isError: true, callId: "c2" });
  expect(units[3]!.text).toBe('bash({"command":"npm test"})\n[error] exit 1');
  expect(previousSummary).toBeUndefined();
  expect([...fileOps.read]).toEqual(["src/a.ts"]);
  expect([...fileOps.edited]).toEqual(["src/cache.ts"]);
  expect([...fileOps.written]).toEqual(["src/new.ts"]);
});

test("extractUnits: the history up to the last compaction summary is that summary", () => {
  const { units, previousSummary } = extractUnits([
    user("first"),
    assistant(["Old summary 1"], [], true),
    user("second"),
    assistant(["The earlier summary"], [], true),
    user("third", true),
    user("fourth"),
    assistant(["Done."]),
  ]);
  expect(previousSummary).toBe("The earlier summary");
  expect(units.map((u) => u.text)).toEqual(["fourth", "Done."]);
  expect(units[0]!.message).toBe(5);
  expect(extractUnits([]).units).toEqual([]);
});

test("recentTexts and lastUserMessages", () => {
  const messages = [user("first"), assistant(["Looking."]), user("second"), assistant(["Running", "the tests."])];
  expect(recentTexts(messages)).toEqual({ user: "second", assistant: "Running\nthe tests." });
  // Assistant text from an earlier turn does not count; synthetic user parts are skipped.
  expect(recentTexts([user("first"), assistant(["Looking."]), user("second")])).toEqual({ user: "second", assistant: "" });
  expect(recentTexts([user("real"), assistant(["Done."]), user("continue", true)])).toEqual({ user: "real", assistant: "Done." });
  expect(recentTexts([])).toEqual({ user: "", assistant: "" });
  expect(lastUserMessages([user("a"), user("b"), assistant(["x"]), user("c")], 2)).toBe("b\n---\nc");
  expect(lastUserMessages([], 2)).toBe("");
});
