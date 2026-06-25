import { useState } from "react";
import { HostState } from "../types";
import { PingSession } from "../hooks/usePing";
import { formatLatency, getRegionLabel } from "../utils/network";
import LatencyChart from "./LatencyChart";
import NetworkRoute from "./NetworkRoute";
import DiagnosticConsole from "./DiagnosticConsole";
import VpnBanner from "./VpnBanner";

interface Props {
  host: HostState;
  session: PingSession;
  onPing: () => void;
  onEdit: () => void;
  onRefresh: () => void;
  onOpenSSH: () => void;
}

export default function HostDetailView({ host, session, onPing, onEdit, onRefresh, onOpenSSH }: Props) {
  const [vpnDismissed, setVpnDismissed] = useState(false);

  const { lastResult, isRunning, stats, logs, history, vpnAtFailure } = session;

  const isFailure = lastResult !== null && !lastResult.success;
  const isSuccess = lastResult !== null && lastResult.success;

  const statusLabel = isRunning ? "PINGING" : isSuccess ? "STABLE" : isFailure ? "FAILURE STATE" : "IDLE";
  const statusColor = isRunning ? "#f59e0b" : isSuccess ? "#22c55e" : isFailure ? "#ef4444" : "var(--text4)";

  const showVpnBanner =
    isFailure &&
    !vpnDismissed &&
    vpnAtFailure !== null;

  // Dismiss banner when a new ping starts or succeeds
  const handlePing = () => {
    setVpnDismissed(false);
    onPing();
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] flex-shrink-0"
        style={{ background: "var(--bg1)" }}
      >
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-[var(--text)] text-lg">{host.hostname}</h1>
          <span
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium"
            style={{
              background: `${statusColor}18`,
              color: statusColor,
              border: `1px solid ${statusColor}40`,
            }}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${isRunning ? "ping-pulsing" : ""}`}
              style={{ backgroundColor: statusColor }}
            />
            {statusLabel}
          </span>
          <span className="text-[11px] text-[var(--text4)] font-mono">
            {getRegionLabel(host.ip)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handlePing}
            disabled={isRunning}
            title="Re-run ping"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={isRunning ? "animate-spin" : ""}>
              <path d="M13 7A6 6 0 1 1 7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M13 1v6h-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={onEdit}
            title="Edit host"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M9 2l3 3L4 13H1v-3L9 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={onRefresh}
            title="Clear history"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M7 4v3l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>

          {/* SSH button */}
          <button
            onClick={onOpenSSH}
            title="Open SSH session"
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg text-[var(--text3)] hover:text-[#818cf8] hover:bg-[#6366f110] border border-transparent hover:border-[#6366f120] transition-all text-[11px] font-medium"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="1" y="2.5" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
              <path d="M3 6.5L4.5 5L3 3.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5.5 6.5H8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
            SSH
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {/* VPN / failure diagnostics banner */}
        {showVpnBanner && vpnAtFailure && (
          <VpnBanner
            vpnStatus={vpnAtFailure}
            ip={host.ip}
            errorKind={lastResult?.error_kind ?? null}
            onDismiss={() => setVpnDismissed(true)}
          />
        )}

        {/* Failure: no VPN detected but still helpful hint */}
        {isFailure && !showVpnBanner && !vpnDismissed && lastResult && (
          <div
            className="rounded-xl border border-[#ef444430] p-4 flex items-start gap-3"
            style={{ background: "var(--bg)" }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="flex-shrink-0 mt-0.5">
              <circle cx="9" cy="9" r="7.5" stroke="#ef4444" strokeWidth="1.2" />
              <path d="M9 5.5v4M9 11.5v1" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <div>
              <div className="text-[#ef4444] font-medium text-sm mb-0.5">Ping Failed</div>
              <p className="text-[#8b4444] text-[13px]">{lastResult.error_detail}</p>
              {lastResult.is_private_ip && (
                <p className="text-[#6b3333] text-[12px] mt-1">
                  This is a private IP — you may need to be on the same network or connected via VPN.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Success state: real-time panel */}
        {!isFailure && (
          <div className="grid grid-cols-2 gap-4">
            {/* Big latency */}
            <div
              className="rounded-xl border border-[var(--border)] p-5 col-span-1"
              style={{ background: "var(--bg2)" }}
            >
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] tracking-widest text-[var(--text3)] uppercase">
                  Real-Time
                </span>
                {isSuccess && (
                  <span className="flex items-center gap-1 text-[#22c55e] text-[11px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e]" />
                    Stable
                  </span>
                )}
              </div>

              {lastResult?.success ? (
                <div>
                  <div className="flex items-end gap-1 mb-4">
                    <span
                      className={`font-bold tabular-nums leading-none ${
                        (lastResult.latency_ms ?? 0) > 200
                          ? "text-[#ef4444]"
                          : (lastResult.latency_ms ?? 0) > 80
                          ? "text-[#f59e0b]"
                          : "text-[var(--text)]"
                      }`}
                      style={{ fontSize: "clamp(2rem, 5vw, 3.5rem)" }}
                    >
                      {Math.round(lastResult.latency_ms ?? 0)}
                    </span>
                    <span className="text-[var(--text3)] text-sm mb-2">ms</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: "JITTER", value: stats.jitter !== null ? `${Math.round(stats.jitter)}ms` : "—" },
                      { label: "LOSS", value: `${Math.round(stats.loss)}%` },
                      { label: "UP", value: `${stats.uptime.toFixed(1)}%` },
                    ].map(({ label, value }) => (
                      <div key={label} className="text-center">
                        <div className="text-[9px] tracking-widest text-[var(--text3)] uppercase mb-1">
                          {label}
                        </div>
                        <div className="text-sm font-mono text-[var(--text2)]">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-24 text-[var(--text5)]">
                  <div className="text-4xl font-bold mb-1">—</div>
                  <div className="text-xs">No data yet</div>
                </div>
              )}
            </div>

            {/* Stats right */}
            <div
              className="rounded-xl border border-[var(--border)] p-5 flex flex-col justify-between"
              style={{ background: "var(--bg2)" }}
            >
              <span className="text-[10px] tracking-widest text-[var(--text3)] uppercase">
                Session Stats
              </span>
              <div className="space-y-3">
                {[
                  { label: "Avg Latency", value: stats.avg !== null ? formatLatency(stats.avg) : "—", color: "#00c8a8" },
                  { label: "Max Latency", value: stats.max !== null ? formatLatency(stats.max) : "—", color: "#f59e0b" },
                  { label: "Samples", value: `${history.length}`, color: "#6366f1" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-[11px] text-[var(--text3)]">{label}</span>
                    <span className="font-mono text-sm" style={{ color }}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Failure state big display */}
        {isFailure && (
          <div
            className="rounded-xl border border-[#ef444420] p-8 flex flex-col items-center justify-center"
            style={{ background: "var(--bg)" }}
          >
            {/* Crossed monitor icon */}
            <svg width="60" height="60" viewBox="0 0 60 60" fill="none" className="mb-4 opacity-70">
              <rect x="4" y="10" width="52" height="34" rx="3" stroke="#ef4444" strokeWidth="2" />
              <path d="M22 44v6M38 44v6M14 50h32" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
              <line x1="12" y1="12" x2="48" y2="42" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" />
              <line x1="48" y1="12" x2="12" y2="42" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <div className="text-4xl font-bold tracking-widest text-[#ef4444] mb-2">
              UNREACHABLE
            </div>
            <div className="text-[11px] tracking-[0.3em] text-[#6b2222] uppercase">
              {lastResult?.error_kind?.replace("_", " ") ?? "unknown error"} · Packet Loss 100%
            </div>
          </div>
        )}

        {/* Latency chart */}
        <LatencyChart
          history={history}
          avg={stats.avg}
          max={stats.max}
        />

        {/* Network route + console side by side */}
        <div className="grid grid-cols-2 gap-4">
          <NetworkRoute
            ip={host.ip}
            hostname={host.hostname}
            isRunning={isRunning}
            success={lastResult?.success ?? null}
          />
          <DiagnosticConsole logs={logs} />
        </div>
      </div>

      {/* Footer: Run ping button */}
      <div
        className="flex-shrink-0 px-5 py-4 border-t border-[var(--border)] flex items-center justify-end"
        style={{ background: "var(--bg1)" }}
      >
        <button
          onClick={handlePing}
          disabled={isRunning}
          className="flex items-center gap-2.5 px-6 py-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          style={{
            background: isRunning ? "#2d2d4a" : "#00c8a8",
            color: isRunning ? "var(--text3)" : "#000",
            boxShadow: isRunning ? "none" : "0 0 20px #00c8a840",
          }}
        >
          {isRunning ? (
            <>
              <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              Pinging...
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 2l7 4-7 4V2Z" fill="currentColor" />
              </svg>
              Run Ping
            </>
          )}
        </button>
      </div>
    </div>
  );
}
