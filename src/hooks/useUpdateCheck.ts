import { useEffect, useState } from "react";

const CURRENT_VERSION = "0.1.0";
const REPO = "soham-verma/pingnet";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

// Cache key — store check timestamp + result so we don't hammer the API
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
  /** A newer version is available */
  available: boolean;
  /** e.g. "0.2.0" */
  latestVersion: string | null;
  /** GitHub releases page URL */
  releaseUrl: string;
}

export function useUpdateCheck(): UpdateInfo {
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    // Delay check by 3 s so it doesn't compete with app startup
    const timer = setTimeout(async () => {
      try {
        // Check local cache first
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const cache: CacheEntry = JSON.parse(raw);
          if (Date.now() - cache.checkedAt < CACHE_TTL_MS) {
            if (cache.latestVersion) setLatestVersion(cache.latestVersion);
            return;
          }
        }

        const res = await fetch(API_URL, {
          headers: { "User-Agent": `Pingnet/${CURRENT_VERSION}` },
        });
        const data = await res.json() as { tag_name?: string };
        const tag = data.tag_name ?? null;

        // Cache the result
        const entry: CacheEntry = { checkedAt: Date.now(), latestVersion: tag };
        localStorage.setItem(CACHE_KEY, JSON.stringify(entry));

        if (tag) setLatestVersion(tag);
      } catch {
        // Network unavailable or rate-limited — silently ignore
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, []);

  const available = latestVersion !== null && isNewer(latestVersion, CURRENT_VERSION);

  return { available, latestVersion: latestVersion, releaseUrl: RELEASES_URL };
}
