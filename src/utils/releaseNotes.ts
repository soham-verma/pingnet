// Pure release-note utilities extracted from useUpdateCheck so they can be
// imported in tests without pulling in @tauri-apps/api/app.

export interface ReleaseNote { title: string; detail: string | null; }

export function parseSemver(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

export function bumpType(latest: string, current: string): "major" | "minor" | "patch" {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if ((a[0] ?? 0) > (b[0] ?? 0)) return "major";
  if ((a[1] ?? 0) > (b[1] ?? 0)) return "minor";
  return "patch";
}

// Parse a GitHub release body into bullet points.
// Supports: "- **Title** — detail", "- **Title**: detail", "- plain line"
export function parseReleaseNotes(body: string | null): ReleaseNote[] {
  if (!body) return [];
  return body
    .split("\n")
    .filter((l) => l.trim().startsWith("- ") || l.trim().startsWith("* "))
    .map((l) => {
      const text = l.trim().replace(/^[-*]\s+/, "");
      // **Title** — detail  or  **Title**: detail
      const bold = text.match(/^\*\*(.+?)\*\*\s*[-–—:]\s*(.+)$/);
      if (bold) return { title: bold[1], detail: bold[2] };
      // **Title** alone
      const boldOnly = text.match(/^\*\*(.+?)\*\*$/);
      if (boldOnly) return { title: boldOnly[1], detail: null };
      return { title: text, detail: null };
    })
    .filter((n) => n.title.length > 0)
    .slice(0, 6); // cap at 6 bullets
}
