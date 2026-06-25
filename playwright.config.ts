import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: "list",
  // Unit tests — no browser needed; tests import pure TS modules directly
  projects: [{ name: "unit" }],
});
