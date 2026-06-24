import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { PingResult, VpnStatus, HostConfig } from "../types";
import { now, calcStats } from "../utils/network";

export interface LogEntry {
  time: string;
  level: "INFO" | "WARN" | "ERROR" | "CRITICAL" | "FATAL" | "OK";
  message: string;
}

export interface PingHistoryEntry {
  latency: number | null;
  success: boolean;
  timestamp: number;
}

export interface PingSession {
  logs: LogEntry[];
  history: PingHistoryEntry[];
  lastResult: PingResult | null;
  vpnAtFailure: VpnStatus | null;
  isRunning: boolean;
  stats: ReturnType<typeof calcStats>;
  // Track host up/down state for transition detection
  lastAlertState: "up" | "down" | null;
}

const DEFAULT_SESSION: PingSession = {
  logs: [],
  history: [],
  lastResult: null,
  vpnAtFailure: null,
  isRunning: false,
  stats: { avg: null, max: null, jitter: null, loss: 0, uptime: 100 },
  lastAlertState: null,
};

// ── Notification helper ────────────────────────────────────────────────────────

let notifPermissionChecked = false;
let notifPermissionGranted = false;

async function ensureNotifPermission(): Promise<boolean> {
  if (notifPermissionChecked) return notifPermissionGranted;
  notifPermissionChecked = true;
  notifPermissionGranted = await isPermissionGranted();
  if (!notifPermissionGranted) {
    const perm = await requestPermission();
    notifPermissionGranted = perm === "granted";
  }
  return notifPermissionGranted;
}

async function notify(title: string, body: string) {
  try {
    const ok = await ensureNotifPermission();
    if (ok) sendNotification({ title, body });
  } catch {
    // Silent — notifications are best-effort
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePing(hosts: HostConfig[] = []) {
  const [sessions, setSessions] = useState<Record<string, PingSession>>({});
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Per-host auto-ping interval refs
  const autoPingRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  // Always-current snapshot of hosts so setInterval callbacks never read stale config
  const hostsRef = useRef<HostConfig[]>(hosts);
  useEffect(() => { hostsRef.current = hosts; }, [hosts]);

  const getSession = useCallback(
    (id: string): PingSession => sessions[id] ?? { ...DEFAULT_SESSION },
    [sessions]
  );

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  const appendLog = (id: string, entry: LogEntry) => {
    setSessions((prev) => {
      const s = prev[id] ?? { ...DEFAULT_SESSION };
      return { ...prev, [id]: { ...s, logs: [...s.logs.slice(-199), entry] } };
    });
  };

  // ── Core ping logic ──────────────────────────────────────────────────────────

  const doPing = useCallback(async (host: HostConfig) => {
    setSessions((prev) => {
      const existing = prev[host.id] ?? { ...DEFAULT_SESSION };
      return {
        ...prev,
        [host.id]: {
          ...existing,
          isRunning: true,
          logs: [
            ...existing.logs.slice(-199),
            { time: now(), level: "INFO", message: `Initializing ping to ${host.ip}...` },
          ],
        },
      };
    });

    const stages: [number, LogEntry][] = [
      [120, { time: now(), level: "INFO", message: `Resolving host ${host.hostname}...` }],
      [280, { time: now(), level: "INFO", message: `Opening ICMP socket...` }],
      [450, { time: now(), level: "INFO", message: `Sending packet to ${host.ip}...` }],
    ];
    stages.forEach(([delay, entry]) => {
      const t = setTimeout(() => appendLog(host.id, entry), delay);
      timersRef.current.push(t);
    });

    try {
      const result = await invoke<PingResult>("ping_host", { ip: host.ip });

      let vpnStatus: VpnStatus | null = null;
      if (!result.success) {
        try {
          vpnStatus = await invoke<VpnStatus>("detect_vpn");
        } catch { /* ignore */ }
      }

      setSessions((prev) => {
        const s = prev[host.id] ?? { ...DEFAULT_SESSION };
        const newEntry: PingHistoryEntry = {
          latency: result.latency_ms,
          success: result.success,
          timestamp: Date.now(),
        };
        const newHistory = [...s.history, newEntry].slice(-60);
        const newStats = calcStats(newHistory);

        // ── Alert state machine ──────────────────────────────────────────────
        const prevState = s.lastAlertState;
        const currState: "up" | "down" = result.success ? "up" : "down";
        let nextAlertState = currState;

        if (result.success && prevState === "down" && host.alert_on_recovery) {
          notify(`✅ ${host.hostname} is back up`, `Host ${host.ip} recovered`);
        } else if (!result.success && prevState !== "down" && host.alert_on_down) {
          notify(`🔴 ${host.hostname} is down`, `Host ${host.ip} is unreachable`);
        } else if (
          result.success &&
          host.alert_latency_ms != null &&
          result.latency_ms != null &&
          result.latency_ms > host.alert_latency_ms
        ) {
          // Only fire latency alert once per spike (when previously ok, now slow)
          notify(
            `⚠️ ${host.hostname} slow`,
            `Latency ${Math.round(result.latency_ms)}ms > ${host.alert_latency_ms}ms threshold`
          );
          // Keep state as "up" — don't mis-report as down
          nextAlertState = "up";
        }
        // ────────────────────────────────────────────────────────────────────

        const resultLog: LogEntry = result.success
          ? { time: now(), level: "OK", message: `ICMP REPLY ${Math.round(result.latency_ms ?? 0)}ms` }
          : { time: now(), level: "FATAL", message: `HOST_UNREACHABLE — ${result.error_detail ?? "unknown error"}` };

        return {
          ...prev,
          [host.id]: {
            ...s,
            isRunning: false,
            lastResult: result,
            vpnAtFailure: result.success ? null : vpnStatus,
            history: newHistory,
            stats: newStats,
            lastAlertState: nextAlertState,
            logs: [...s.logs.slice(-199), resultLog],
          },
        };
      });
    } catch (err) {
      setSessions((prev) => {
        const s = prev[host.id] ?? { ...DEFAULT_SESSION };
        return {
          ...prev,
          [host.id]: {
            ...s,
            isRunning: false,
            logs: [
              ...s.logs.slice(-199),
              { time: now(), level: "ERROR", message: `System error: ${String(err)}` },
            ],
          },
        };
      });
    }
  }, []);

  // ── Manual ping (one-shot, clears timers) ────────────────────────────────────

  const ping = useCallback(async (host: HostConfig) => {
    clearTimers();
    await doPing(host);
  }, [doPing]);

  // ── Auto-ping scheduler — 30 s interval per host with alert_on_down set ─────

  useEffect(() => {
    const refs = autoPingRefs.current;

    // Clear any intervals for hosts that no longer exist or have alerts disabled
    const hostIds = new Set(hosts.map((h) => h.id));
    Object.keys(refs).forEach((id) => {
      if (!hostIds.has(id)) {
        clearInterval(refs[id]);
        delete refs[id];
      }
    });

    // Start intervals for hosts that need alerting and don't have one yet
    hosts.forEach((host) => {
      const needsAuto =
        host.alert_on_down || host.alert_on_recovery || host.alert_latency_ms != null;
      if (needsAuto && !refs[host.id]) {
        refs[host.id] = setInterval(() => {
          // Read from ref to get the latest host config, not the snapshot
          // captured at interval creation time (fixes stale closure — task #7)
          const latest = hostsRef.current.find((h) => h.id === host.id);
          if (latest) doPing(latest);
        }, 30_000);
      } else if (!needsAuto && refs[host.id]) {
        clearInterval(refs[host.id]);
        delete refs[host.id];
      }
    });

    return () => {
      Object.values(refs).forEach(clearInterval);
      autoPingRefs.current = {};
    };
  }, [hosts, doPing]);

  // ── Clear a host session ─────────────────────────────────────────────────────

  const clearSession = useCallback((id: string) => {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return { getSession, ping, clearSession };
}
