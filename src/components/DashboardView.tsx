import { useState } from "react";
import { HostState } from "../types";
import { PingSession } from "../hooks/usePing";
import { formatLatency } from "../utils/network";

interface Props {
  hosts: HostState[];
  sessions: Record<string, PingSession>;
  onSelectHost: (id: string) => void;
  onOpenSSH: (id: string) => void;
  onAddHost: (prefillIp?: string) => void;
}

function statusFor(session: PingSession | undefined) {
  const lastResult = session?.lastResult ?? null;
  const isRunning = session?.isRunning ?? false;
  if (isRunning) return { label: "PINGING", color: "#f59e0b" };
  if (lastResult === null) return { label: "IDLE", color: "var(--text4)" };
  return lastResult.success
    ? { label: "ONLINE", color: "#22c55e" }
    : { label: "OFFLINE", color: "#ef4444" };
}

export default function DashboardView({ hosts, sessions, onSelectHost, onOpenSSH, onAddHost }: Props) {
  const [connectValue, setConnectValue] = useState("");

  const total = hosts.length;
  const online = hosts.filter((h) => sessions[h.id]?.lastResult?.success).length;
  const offline = hosts.filter((h) => {
    const r = sessions[h.id]?.lastResult;
    return r !== null && r !== undefined && !r.success;
  }).length;
  const latencies = hosts
    .map((h) => sessions[h.id]?.lastResult)
    .filter((r) => r?.success)
    .map((r) => r!.latency_ms ?? 0);
  const avgLatency = latencies.length
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : null;

  function submitConnect() {
    const v = connectValue.trim();
    if (!v) return;
    onAddHost(v);
    setConnectValue("");
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-6 gap-6" style={{ background: "var(--bg)" }}>
      {/* Connect bar */}
      <div
        className="rounded-2xl border border-[var(--border)] p-5 flex items-center gap-4 flex-wrap"
        style={{ background: "var(--bg1)" }}
      >
        <div className="flex-1 min-w-[240px]">
          <div className="text-[11px] tracking-widest text-[#00c8a8] font-semibold uppercase mb-3">
            Connect to Remote Host
          </div>
          <div className="flex items-center gap-3">
            <div
              className="flex-1 flex items-center gap-2 px-3.5 h-11 rounded-xl border border-[var(--border2)]"
              style={{ background: "var(--bg2)" }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-[var(--text4)] flex-shrink-0">
                <rect x="1" y="4" width="12" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
                <path d="M3.5 6.5h.01M6 6.5h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                value={connectValue}
                onChange={(e) => setConnectValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitConnect()}
                placeholder="Enter IP address, hostname..."
                className="flex-1 bg-transparent text-sm text-[var(--text)] placeholder-[var(--text4)] outline-none"
              />
            </div>
            <button
              onClick={submitConnect}
              className="h-11 px-6 rounded-xl font-semibold text-sm text-[var(--text)] transition-all flex-shrink-0"
              style={{ background: "#00c8a8", color: "#000" }}
            >
              Connect
            </button>
          </div>
        </div>

        {/* Summary stats */}
        <div className="flex items-center gap-6 pl-4 flex-wrap">
          {[
            { label: "DEVICES", value: String(total) },
            { label: "ONLINE", value: String(online), color: "#22c55e" },
            { label: "OFFLINE", value: String(offline), color: "#ef4444" },
            { label: "AVG LATENCY", value: avgLatency !== null ? formatLatency(avgLatency) : "—" },
          ].map(({ label, value, color }) => (
            <div key={label} className="text-center">
              <div className="text-[9px] tracking-widest text-[var(--text3)] uppercase mb-1">{label}</div>
              <div className="text-lg font-semibold tabular-nums" style={{ color: color ?? "var(--text)" }}>
                {value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Device grid */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-[var(--text3)]">
            <rect x="1" y="1" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.1" />
            <rect x="7.5" y="1" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.1" />
            <rect x="1" y="7.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.1" />
            <rect x="7.5" y="7.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.1" />
          </svg>
          <h2 className="text-sm font-semibold text-[var(--text)]">Your Devices</h2>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {hosts.map((host) => {
            const session = sessions[host.id];
            const status = statusFor(session);
            const stats = session?.stats;
            const lastResult = session?.lastResult ?? null;

            return (
              <div
                key={host.id}
                className="rounded-xl border border-[var(--border)] p-4 card-glow transition-all"
                style={{ background: "var(--bg1)" }}
              >
                <button onClick={() => onSelectHost(host.id)} className="w-full text-left mb-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-[var(--text)] text-sm truncate">{host.hostname}</span>
                    <span
                      className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium flex-shrink-0"
                      style={{ background: `${status.color}18`, color: status.color, border: `1px solid ${status.color}40` }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: status.color }} />
                      {status.label}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-[var(--text3)]">{host.ip}</div>
                </button>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="rounded-lg px-2.5 py-2" style={{ background: "var(--bg2)" }}>
                    <div className="text-[9px] tracking-widest text-[var(--text4)] uppercase mb-0.5">Latency</div>
                    <div className="text-sm font-mono text-[var(--text2)]">
                      {lastResult?.success ? formatLatency(lastResult.latency_ms ?? 0) : "—"}
                    </div>
                  </div>
                  <div className="rounded-lg px-2.5 py-2" style={{ background: "var(--bg2)" }}>
                    <div className="text-[9px] tracking-widest text-[var(--text4)] uppercase mb-0.5">Uptime</div>
                    <div className="text-sm font-mono text-[var(--text2)]">
                      {stats && session && session.history.length > 0 ? `${stats.uptime.toFixed(0)}%` : "—"}
                    </div>
                  </div>
                </div>

                <div className="flex gap-1.5">
                  <button
                    onClick={() => onSelectHost(host.id)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-medium text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <circle cx="5" cy="5" r="1.5" fill="currentColor" />
                      <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="0.8" strokeOpacity="0.5" />
                    </svg>
                    Ping
                  </button>
                  <button
                    onClick={() => onOpenSSH(host.id)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-medium text-[var(--text3)] hover:text-[#818cf8] hover:bg-[#6366f110] transition-all"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <rect x="0.5" y="1.5" width="9" height="7" rx="1.2" stroke="currentColor" strokeWidth="0.9" />
                      <path d="M2.3 5L3.6 3.7L2.3 2.4" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    SSH
                  </button>
                </div>
              </div>
            );
          })}

          {/* Add device tile */}
          <button
            onClick={() => onAddHost()}
            className="rounded-xl border border-dashed border-[var(--border2)] flex flex-col items-center justify-center gap-2 py-8 text-[var(--text4)] hover:text-[#00c8a8] hover:border-[#00c8a850] transition-all min-h-[168px]"
          >
            <span className="w-9 h-9 rounded-full border border-current flex items-center justify-center text-lg">+</span>
            <span className="text-[12px] font-medium">Add device</span>
          </button>
        </div>

        {hosts.length === 0 && (
          <p className="text-[var(--text3)] text-sm mt-4">
            No devices yet — connect to a host above or add one to get started.
          </p>
        )}
      </div>
    </div>
  );
}
