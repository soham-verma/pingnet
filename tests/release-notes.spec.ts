import { test, expect } from "@playwright/test";
import { parseReleaseNotes, isNewer, bumpType } from "../src/utils/releaseNotes";

// ── isNewer ───────────────────────────────────────────────────────────────────

test.describe("isNewer", () => {
  test("1.0.0 is newer than 0.9.0", () => {
    expect(isNewer("1.0.0", "0.9.0")).toBe(true);
  });

  test("0.5.0 is newer than 0.4.9", () => {
    expect(isNewer("0.5.0", "0.4.9")).toBe(true);
  });

  test("0.4.1 is newer than 0.4.0", () => {
    expect(isNewer("0.4.1", "0.4.0")).toBe(true);
  });

  test("same version is not newer", () => {
    expect(isNewer("0.4.0", "0.4.0")).toBe(false);
  });

  test("older version is not newer", () => {
    expect(isNewer("0.3.9", "0.4.0")).toBe(false);
  });

  test("handles v-prefix", () => {
    expect(isNewer("v1.0.0", "0.9.0")).toBe(true);
    expect(isNewer("v0.4.0", "v0.4.0")).toBe(false);
  });
});

// ── bumpType ──────────────────────────────────────────────────────────────────

test.describe("bumpType", () => {
  test("major bump", () => {
    expect(bumpType("2.0.0", "1.9.9")).toBe("major");
  });

  test("minor bump", () => {
    expect(bumpType("0.5.0", "0.4.9")).toBe("minor");
  });

  test("patch bump", () => {
    expect(bumpType("0.4.1", "0.4.0")).toBe("patch");
  });
});

// ── parseReleaseNotes ─────────────────────────────────────────────────────────

test.describe("parseReleaseNotes", () => {
  test("null body returns empty array", () => {
    expect(parseReleaseNotes(null)).toEqual([]);
  });

  test("empty string returns empty array", () => {
    expect(parseReleaseNotes("")).toEqual([]);
  });

  test("parses bold title with em-dash detail", () => {
    const notes = parseReleaseNotes("- **Auto-ping** — fires every 30s");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Auto-ping");
    expect(notes[0].detail).toBe("fires every 30s");
  });

  test("parses bold title with colon detail", () => {
    const notes = parseReleaseNotes("- **Fix**: resolves crash on startup");
    expect(notes[0].title).toBe("Fix");
    expect(notes[0].detail).toBe("resolves crash on startup");
  });

  test("parses bold-only title", () => {
    const notes = parseReleaseNotes("- **New feature**");
    expect(notes[0].title).toBe("New feature");
    expect(notes[0].detail).toBeNull();
  });

  test("parses plain bullet", () => {
    const notes = parseReleaseNotes("- Plain text item");
    expect(notes[0].title).toBe("Plain text item");
    expect(notes[0].detail).toBeNull();
  });

  test("supports * bullets", () => {
    const notes = parseReleaseNotes("* **Feature** — detail");
    expect(notes[0].title).toBe("Feature");
  });

  test("ignores non-bullet lines", () => {
    const body = `# v0.4.0\nSome intro text.\n- **Fix** — bug fixed\nAnother line.`;
    const notes = parseReleaseNotes(body);
    expect(notes).toHaveLength(1);
  });

  test("caps at 6 bullets", () => {
    const body = Array.from({ length: 10 }, (_, i) => `- Item ${i + 1}`).join("\n");
    expect(parseReleaseNotes(body)).toHaveLength(6);
  });
});
