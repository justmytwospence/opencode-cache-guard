import { expect, test } from "vitest";
import { segments } from "../src/tui.ts";

test("warm: time left and keep-warm count in the line's color", () => {
  expect(segments({ left: "4:12", warms: 2 }, "W")).toEqual([{ text: "cache " }, { text: "4:12" }, { text: " \u21bb2" }]);
});

test("cold: in the warning color, no count when none", () => {
  expect(segments({ cold: "cold", warms: 0 }, "W")).toEqual([{ text: "cache " }, { text: "cold", color: "W" }]);
});

test("no state: nothing", () => {
  expect(segments(undefined, "W")).toBeUndefined();
});
