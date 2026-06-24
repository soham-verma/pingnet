import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

const REPO = "soham-verma/pingnet";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

const CACHE_KEY = "pingnet_update_check";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CacheEntry {
  checkedAt: number;
  latestVersion: string | null;
}

function parseSemver(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

export interface UpdateInfo {
  available: boolean;
  latestVersion: string | null;
  releaseUrl: string;
}

export function useUpdateCheck(): UpdateInfo {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion]   = useState<string | null>(null);

  // Read the real app version from tauri.conf.json at runtime — never hardcode it
  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => setCurrentVersion(null));
  }, []);

  useEffect(() => {
    if (!currentVersion) return;

    const timer = setTimeout(async () => {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const cache: CacheEntry = JSON.parse(raw);
          if (Date.now() - cache.checkedAt < CACHE_TTL_MS) {
            if (cache.latestVersion) setLatestVersion(cache.latestVersion);
            return;
          }
        }

        const res = await fetch(API_URL, {
          headers: { "User-Agent": `Pingnet/${currentVersion}` },
        });
        const data = await res.json() as { tag_name?: string };
        const tag = data.tag_name ?? null;

        localStorage.setItem(CACHE_KEY, JSON.stringify({
          checkedAt: Date.now(),
          latestVersion: tag,
        } satisfies CacheEntry));

        if (tag) setLatestVersion(tag);
      } catch {
        // Network unavailable or rate-limited — silently ignore
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [currentVersion]);

  const available =
    currentVersion !== null &&
    latestVersion !== null &&
    isNewer(latestVersion, currentVersion);

  return { available, latestVersion, releaseUrl: RELEASES_URL };
}
