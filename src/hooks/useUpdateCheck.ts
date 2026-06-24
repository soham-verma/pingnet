import { useEffect, useState, useCallback } from "react";
import { getVersion } from "@tauri-apps/api/app";

const REPO = "soham-verma/pingnet";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheKey(currentVersion: string) {
  return `pingnet_update_check_${currentVersion}`;
}

function skipKey(version: string) {
  return `pingnet_skip_version_${version}`;
}

interface CacheEntry {
  checkedAt: number;
  latestVersion: string | null;
  releaseBody: string | null;
}

function parseSemver(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(candidate: string, current: string): boolean {
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

export interface ReleaseNote { title: string; detail: string | null; }

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

export interface UpdateInfo {
  available: boolean;
  skipped: boolean;
  checking: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  bump: "major" | "minor" | "patch" | null;
  releaseNotes: ReleaseNote[];
  releaseUrl: string;
  skipVersion: () => void;
  checkNow: () => void;
}

export function useUpdateCheck(): UpdateInfo {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion]   = useState<string | null>(null);
  const [releaseBody, setReleaseBody]        = useState<string | null>(null);
  const [checking, setChecking]              = useState(false);
  const [skipped, setSkipped]                = useState(false);

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => setCurrentVersion(null));
  }, []);

  const doCheck = useCallback(async (currentVersion: string, force = false) => {
    setChecking(true);
    try {
      const key = cacheKey(currentVersion);
      if (!force) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const cache: CacheEntry = JSON.parse(raw);
          if (Date.now() - cache.checkedAt < CACHE_TTL_MS) {
            if (cache.latestVersion) {
              setLatestVersion(cache.latestVersion);
              setReleaseBody(cache.releaseBody);
            }
            return;
          }
        }
      }

      const res = await fetch(API_URL, {
        headers: { "User-Agent": `Pingnet/${currentVersion}` },
      });

      // Validate the HTTP response before trying to parse JSON.
      // A 403 (rate-limit) or 404 (repo not found) returns non-JSON body
      // that would silently swallow the error and poison the cache.
      if (!res.ok) {
        // Don't cache failed responses — try again next time
        return;
      }

      // Runtime-validate the response shape before reading fields.
      // The GitHub API could change; fail safe rather than crashing.
      const raw: unknown = await res.json();
      if (typeof raw !== "object" || raw === null) return;
      const data = raw as Record<string, unknown>;
      const tag:  string | null = typeof data.tag_name === "string" ? data.tag_name : null;
      const body: string | null = typeof data.body === "string" ? data.body : null;

      localStorage.setItem(key, JSON.stringify({
        checkedAt: Date.now(),
        latestVersion: tag,
        releaseBody: body,
      } satisfies CacheEntry));

      if (tag)  setLatestVersion(tag);
      if (body) setReleaseBody(body);
    } catch {
      // Network unavailable or rate-limited — silently ignore
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!currentVersion) return;
    const t = setTimeout(() => doCheck(currentVersion), 3000);
    return () => clearTimeout(t);
  }, [currentVersion, doCheck]);

  // Check if this version has been skipped
  useEffect(() => {
    if (!latestVersion) return;
    setSkipped(localStorage.getItem(skipKey(latestVersion)) === "1");
  }, [latestVersion]);

  const available =
    currentVersion !== null &&
    latestVersion !== null &&
    isNewer(latestVersion, currentVersion);

  return {
    available,
    skipped,
    checking,
    currentVersion,
    latestVersion,
    bump: available && latestVersion && currentVersion
      ? bumpType(latestVersion, currentVersion) : null,
    releaseNotes: parseReleaseNotes(releaseBody),
    releaseUrl: RELEASES_URL,
    skipVersion: () => {
      if (latestVersion) {
        localStorage.setItem(skipKey(latestVersion), "1");
        setSkipped(true);
      }
    },
    checkNow: () => { if (currentVersion) doCheck(currentVersion, true); },
  };
}
