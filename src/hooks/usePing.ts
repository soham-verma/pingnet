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
  // Track host up/down/slow state for transition detection
  lastAlertState: "up" | "down" | "slow" | null;
}

// ── Alert state machine (pure, exported for tests) ────────────────────────────

export type AlertState = "up" | "down" | "slow" | null;
export type AlertFire  = "down" | "recovery" | "slow" | null;

export interface AlertStateInput {
  prevState: AlertState;
  success: boolean;
  latency_ms: number | null;
  alert_on_down: boolean;
  alert_on_recovery: boolean;
  alert_latency_ms: number | null;
}

/**
 * Pure function: given the previous alert state and a new ping result, returns
 * the next state and which notification (if any) should fire.
 * No side-effects — suitable for unit testing without React or Tauri.
 */
export function computeNextAlertState(input: AlertStateInput): {
  nextState: "up" | "down" | "slow";
  fire: AlertFire;
} {
  const { prevState, success, latency_ms, alert_on_down, alert_on_recovery, alert_latency_ms } = input;

  const isSlowPing =
    success &&
    alert_latency_ms != null &&
    latency_ms != null &&
    latency_ms > alert_latency_ms;

  const nextState: "up" | "down" | "slow" =
    !success ? "down" : isSlowPing ? "slow" : "up";

  let fire: AlertFire = null;

  if (success && prevState === "down" && alert_on_recovery) {
    fire = "recovery";
  } else if (!success && prevState !== "down" && alert_on_down) {
    fire = "down";
  } else if (isSlowPing && prevState === "up") {
    fire = "slow";
  }

  return { nextState, fire };
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
  // Per-host auto-ping interval refs — populated only after the user's first manual ping
  const autoPingRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  // Abort tokens — incremented by stopPing() so stale doPing results are discarded
  const pingGenRef = useRef<Record<string, number>>({});
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
    // Snapshot the abort-token for this invocation. If stopPing() is called
    // before the await resolves, the token will have been incremented and we
    // discard the stale result instead of writing it to state.
    const gen = pingGenRef.current[host.id] ?? 0;

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

      // Discard if this ping was stopped while in flight
      if ((pingGenRef.current[host.id] ?? 0) !== gen) return;

      let vpnStatus: VpnStatus | null = null;
      if (!result.success) {
        try {
          vpnStatus = await invoke<VpnStatus>("detect_vpn");
        } catch { /* ignore */ }
      }

      // Check again after the VPN detect await
      if ((pingGenRef.current[host.id] ?? 0) !== gen) return;

      // Start the 30 s auto-ping interval for this host the first time it is
      // manually pinged — but only if it has alert settings configured.
      // This ensures nothing pings on startup without user action.
      const needsAuto =
        host.alert_on_down || host.alert_on_recovery || host.alert_latency_ms != null;
      if (needsAuto && !autoPingRefs.current[host.id]) {
        autoPingRefs.current[host.id] = setInterval(() => {
          const latest = hostsRef.current.find((h) => h.id === host.id);
          if (latest) doPing(latest);
        }, 30_000);
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
        const { nextState: nextAlertState, fire } = computeNextAlertState({
          prevState: s.lastAlertState,
          success: result.success,
          latency_ms: result.latency_ms,
          alert_on_down: host.alert_on_down,
          alert_on_recovery: host.alert_on_recovery,
          alert_latency_ms: host.alert_latency_ms,
        });

        if (fire === "recovery") {
          notify(`✅ ${host.hostname} is back up`, `Host ${host.ip} recovered`);
        } else if (fire === "down") {
          notify(`🔴 ${host.hostname} is down`, `Host ${host.ip} is unreachable`);
        } else if (fire === "slow") {
          notify(
            `⚠️ ${host.hostname} slow`,
            `Latency ${Math.round(result.latency_ms!)}ms > ${host.alert_latency_ms}ms threshold`
          );
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
      if ((pingGenRef.current[host.id] ?? 0) !== gen) return;
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

  // ── Stop an in-flight ping ───────────────────────────────────────────────────
  // Increments the abort token for the host so doPing() discards its result
  // once it resolves from the OS. Resets isRunning immediately in the UI.

  const stopPing = useCallback((hostId: string) => {
    pingGenRef.current[hostId] = (pingGenRef.current[hostId] ?? 0) + 1;
    clearTimers();
    setSessions((prev) => {
      const s = prev[hostId];
      if (!s) return prev;
      return {
        ...prev,
        [hostId]: {
          ...s,
          isRunning: false,
          logs: [
            ...s.logs.slice(-199),
            { time: now(), level: "WARN", message: "Ping cancelled by user." },
          ],
        },
      };
    });
  }, []);

  // ── Auto-ping interval lifecycle ─────────────────────────────────────────────
  // Intervals are started inside doPing (on the user's first manual ping) so
  // nothing fires automatically on app startup. This effect only handles
  // cleanup: stop intervals when a host is deleted or its alerts are removed.

  useEffect(() => {
    const refs = autoPingRefs.current;
    const hostMap = new Map(hosts.map((h) => [h.id, h]));
    Object.keys(refs).forEach((id) => {
      const h = hostMap.get(id);
      const stillNeeds = h && (h.alert_on_down || h.alert_on_recovery || h.alert_latency_ms != null);
      if (!stillNeeds) {
        clearInterval(refs[id]);
        delete refs[id];
      }
    });
    return () => {
      Object.values(autoPingRefs.current).forEach(clearInterval);
      autoPingRefs.current = {};
    };
  }, [hosts]);

  // ── Clear a host session ─────────────────────────────────────────────────────

  const clearSession = useCallback((id: string) => {
    // Also stop the auto-ping interval for this host
    if (autoPingRefs.current[id]) {
      clearInterval(autoPingRefs.current[id]);
      delete autoPingRefs.current[id];
    }
    setSessions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return { getSession, ping, stopPing, clearSession };
}
