import { test, expect } from "@playwright/test";
import { nextFocusIndex } from "../src/hooks/useDialog";

test("Tab wraps from last to first, Shift+Tab from first to last", () => {
  expect(nextFocusIndex(3, 2, false)).toBe(0);
  expect(nextFocusIndex(3, 0, true)).toBe(2);
  expect(nextFocusIndex(3, 1, false)).toBe(2);
});

test("focus outside the dialog is pulled back in", () => {
  expect(nextFocusIndex(3, -1, false)).toBe(0);
  expect(nextFocusIndex(3, -1, true)).toBe(2);
  expect(nextFocusIndex(0, -1, false)).toBe(-1);
});
