import { useEffect, useState, useCallback, useRef } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isNewer, bumpType, parseReleaseNotes, type ReleaseNote } from "../utils/releaseNotes";

// Re-export so existing callers can still import from this module
export type { ReleaseNote };
export { bumpType, parseReleaseNotes };

const REPO = "soham-verma/pingnet";
// Fallback link shown only if the in-app download/install path fails
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

function skipKey(version: string) {
  return `pingnet_skip_version_${version}`;
}

export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

export interface UpdateInfo {
  available: boolean;
  skipped: boolean;
  checking: boolean;
  downloading: boolean;
  installed: boolean;
  progress: DownloadProgress | null;
  error: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  bump: "major" | "minor" | "patch" | null;
  releaseNotes: ReleaseNote[];
  releaseUrl: string;
  skipVersion: () => void;
  checkNow: () => void;
  installUpdate: () => Promise<void>;
}

/** Strip leading "v" and return bare semver string, e.g. "v0.4.2" → "0.4.2" */
function normalizeVersion(v: string): string {
  return v.replace(/^v/i, "").trim();
}

export function useUpdateCheck(): UpdateInfo {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion]   = useState<string | null>(null);
  const [releaseBody, setReleaseBody]        = useState<string | null>(null);
  const [checking, setChecking]              = useState(false);
  const [skipped, setSkipped]                = useState(false);
  const [downloading, setDownloading]        = useState(false);
  const [installed, setInstalled]            = useState(false);
  const [progress, setProgress]              = useState<DownloadProgress | null>(null);
  const [error, setError]                    = useState<string | null>(null);

  // Holds the live Update handle returned by the updater plugin so installUpdate()
  // can act on it without re-fetching. Not state — it doesn't need to trigger renders.
  const pendingUpdate = useRef<Update | null>(null);

  useEffect(() => {
    getVersion()
      .then((v) => {
        const norm = normalizeVersion(v ?? "");
        // Guard against Tauri placeholder "0.0.0" which would always
        // trigger an update notification.
        setCurrentVersion(norm && norm !== "0.0.0" ? norm : null);
      })
      .catch(() => setCurrentVersion(null));
  }, []);

  const doCheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      // Talks to the endpoint configured in tauri.conf.json (a `latest.json`
      // manifest tauri-action publishes alongside each GitHub release). The
      // plugin itself compares versions, so a null result means "up to date".
      const update = await check();
      pendingUpdate.current = update ?? null;
      if (update) {
        setLatestVersion(normalizeVersion(update.version));
        setReleaseBody(update.body ?? null);
      }
    } catch {
      // Network unavailable or endpoint unreachable — silently ignore, try again next time
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    // Give the window a moment to settle before hitting the network on launch
    const t = setTimeout(() => { doCheck(); }, 3000);
    return () => clearTimeout(t);
  }, [doCheck]);

  // Check if this version has been skipped
  useEffect(() => {
    if (!latestVersion) return;
    setSkipped(localStorage.getItem(skipKey(latestVersion)) === "1");
  }, [latestVersion]);

  const available =
    currentVersion !== null &&
    latestVersion !== null &&
    isNewer(latestVersion, currentVersion);

  // Downloads the signed update bundle, installs it, and relaunches the app —
  // no browser, no manual download, no pointing the user at GitHub.
  const installUpdate = useCallback(async () => {
    let update = pendingUpdate.current;
    if (!update) {
      // Hook may have re-mounted since the last check (e.g. modal reopened) — re-fetch.
      try {
        update = await check();
        pendingUpdate.current = update ?? null;
      } catch {
        setError("Couldn't reach the update server. Check your connection and try again.");
        return;
      }
    }
    if (!update) return;

    setDownloading(true);
    setError(null);
    setProgress(null);
    let total: number | null = null;
    let downloaded = 0;

    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            setProgress({ downloaded: 0, total });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress({ downloaded, total });
            break;
          case "Finished":
            setProgress({ downloaded: total ?? downloaded, total });
            break;
        }
      });
      setInstalled(true);
      // On Windows the app is already force-quit by the installer at this point;
      // relaunch() is what actually brings it back on macOS/Linux.
      await relaunch();
    } catch {
      setError("Update failed to install. Please try again, or download it manually from GitHub.");
    } finally {
      setDownloading(false);
    }
  }, []);

  return {
    available,
    skipped,
    checking,
    downloading,
    installed,
    progress,
    error,
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
    checkNow: () => { doCheck(); },
    installUpdate,
  };
}
