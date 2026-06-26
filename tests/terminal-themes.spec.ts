import { test, expect } from "@playwright/test";
import {
  TERMINAL_THEMES,
  getTerminalTheme,
  DEFAULT_TERMINAL_THEME_ID,
} from "../src/utils/terminalThemes";

test.describe("terminalThemes", () => {
  test("has multiple themes with required fields", () => {
    expect(TERMINAL_THEMES.length).toBeGreaterThanOrEqual(5);
    for (const t of TERMINAL_THEMES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.xterm.background).toBeTruthy();
      expect(t.xterm.foreground).toBeTruthy();
      expect(t.ghostColor).toMatch(/^#/);
    }
  });

  test("getTerminalTheme falls back to default", () => {
    expect(getTerminalTheme("nonexistent").id).toBe(DEFAULT_TERMINAL_THEME_ID);
    expect(getTerminalTheme("dracula").name).toBe("Dracula");
  });
});
