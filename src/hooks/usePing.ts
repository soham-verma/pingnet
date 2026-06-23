import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
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
}

const DEFAULT_SESSION: PingSession = {
  logs: [],
  history: [],
  lastResult: null,
  vpnAtFailure: null,
  isRunning: false,
  stats: { avg: null, max: null, jitter: null, loss: 0, uptime: 100 },
};

export function usePing() {
  const [sessions, setSessions] = useState<Record<string, PingSession>>({});
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

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

  const ping = useCallback(async (host: HostConfig) => {
    clearTimers();

    // Mark as running & add opening log entry
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

    // Staged fake log entries to mimic terminal feel while real ping runs
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
        // Detect VPN on failure
        try {
          vpnStatus = await invoke<VpnStatus>("detect_vpn");
        } catch {
          // VPN detection failed — proceed without it
        }
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

        const resultLog: LogEntry = result.success
          ? {
              time: now(),
              level: "OK",
              message: `ICMP REPLY ${Math.round(result.latency_ms ?? 0)}ms`,
            }
          : {
              time: now(),
              level: "FATAL",
              message: `HOST_UNREACHABLE — ${result.error_detail ?? "unknown error"}`,
            };

        return {
          ...prev,
          [host.id]: {
            ...s,
            isRunning: false,
            lastResult: result,
            vpnAtFailure: result.success ? null : vpnStatus,
            history: newHistory,
            stats: newStats,
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

  const clearSession = useCallback((id: string) => {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  return { getSession, ping, clearSession };
}
