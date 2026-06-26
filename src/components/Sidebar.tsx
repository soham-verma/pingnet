import { HostState } from "../types";
import { PingSession } from "../hooks/usePing";
import { formatLatency } from "../utils/network";
import { Theme } from "../hooks/useTheme";

interface Props {
  hosts: HostState[];
  selectedId: string | null;
  sessions: Record<string, PingSession>;
  viewMode: "ping" | "ssh";
  onSelect: (id: string) => void;
  onOpenSSH: (id: string) => void;
  onAddHost: () => void;
  onOpenKeyManager: () => void;
  onOpenShortcuts: () => void;
  currentVersion: string | null;
  updateAvailable: boolean;
  onOpenUpdate: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

function MiniBar({ history }: { history: { latency: number | null; success: boolean }[] }) {
  const last12 = history.slice(-12);
  const maxLat = Math.max(...last12.map((h) => h.latency ?? 0), 1);

  return (
    <div className="flex items-end gap-[2px] h-4">
      {last12.map((h, i) => {
        const height = h.success && h.latency ? Math.max(3, (h.latency / maxLat) * 16) : 3;
        return (
          <div
            key={i}
            className="w-[3px] rounded-sm"
            style={{
              height: `${height}px`,
              backgroundColor: h.success ? "#00c8a8" : "#ef4444",
              opacity: 0.7 + (i / last12.length) * 0.3,
            }}
          />
        );
      })}
    </div>
  );
}

export default function Sidebar({ hosts, selectedId, sessions, viewMode, onSelect, onOpenSSH, onAddHost, onOpenKeyManager, onOpenShortcuts, currentVersion, updateAvailable, onOpenUpdate, collapsed, onToggleCollapse, theme, onToggleTheme }: Props) {

  // ── Collapsed rail ──────────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside className="flex-shrink-0 flex flex-col h-full border-r border-[var(--border)] items-center py-4 gap-3" style={{ width: 44, background: "var(--bg1)" }}>
        <button
          onClick={onToggleCollapse}
          title="Expand sidebar"
          className="w-7 h-7 flex items-center justify-center rounded text-[var(--text3)] hover:text-[var(--text2)] hover:bg-[var(--bg3)] transition-all"
        >
          <svg width="13" height="11" viewBox="0 0 13 11" fill="none">
            <rect y="0" width="13" height="1.5" rx="0.75" fill="currentColor"/>
            <rect y="4.5" width="13" height="1.5" rx="0.75" fill="currentColor"/>
            <rect y="9" width="13" height="1.5" rx="0.75" fill="currentColor"/>
          </svg>
        </button>
        {/* Status dots for each host */}
        <div className="flex flex-col gap-2 flex-1 overflow-hidden pt-1">
          {hosts.map(host => {
            const session = sessions[host.id];
            const lastResult = session?.lastResult;
            const isRunning = session?.isRunning ?? false;
            const statusColor = isRunning ? "#f59e0b" : lastResult === null ? "var(--text4)" : lastResult.success ? "#22c55e" : "#ef4444";
            const isSelected = host.id === selectedId;
            return (
              <button
                key={host.id}
                onClick={() => onSelect(host.id)}
                title={host.hostname}
                className="w-7 h-7 flex items-center justify-center rounded transition-all"
                style={isSelected ? { background: "var(--bg-sel)", border: "1px solid var(--border2)" } : {}}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor, boxShadow: `0 0 5px ${statusColor}80` }} />
              </button>
            );
          })}
        </div>
        {/* Theme toggle */}
        <button
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="w-7 h-7 flex items-center justify-center rounded transition-all"
          style={{ color: "var(--text3)" }}
        >
          {theme === "dark"
            ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.8"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          }
        </button>
        {/* Add device icon */}
        <button
          onClick={onAddHost}
          title="Add device"
          className="w-7 h-7 flex items-center justify-center rounded transition-all text-base"
          style={{ color: "var(--text4)" }}
        >+</button>
      </aside>
    );
  }

  // ── Expanded ────────────────────────────────────────────────────────────────
  return (
    <aside className="w-56 flex-shrink-0 flex flex-col h-full border-r border-[var(--border)]" style={{ background: "var(--bg1)" }}>
      {/* Header */}
      <div className="px-4 pt-6 pb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 200 200" fill="none">
            <path d="M 80,148 L 80,64 C 80,44 96,36 112,36 C 138,36 148,60 148,86 C 148,110 132,124 110,124 L 90,124"
              stroke="#00c8a8" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="80" cy="148" r="10" fill="#00c8a8"/>
          </svg>
          <span className="text-[11px] font-semibold tracking-[0.2em] text-[var(--text2)] uppercase">
            Pingboard
          </span>
        </div>
        <button
          onClick={onToggleCollapse}
          title="Collapse sidebar"
          className="w-6 h-6 flex items-center justify-center rounded text-[var(--text5)] hover:text-[var(--text3)] hover:bg-[var(--bg3)] transition-all"
        >
          <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
            <path d="M9 1L5 5L1 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 5L5 9L1 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" opacity="0.4"/>
          </svg>
        </button>
      </div>

      {/* Host list */}
      <div className="flex-1 overflow-y-auto px-2">
        {hosts.length === 0 && (
          <div className="px-3 py-6 text-center text-[var(--text3)] text-xs">
            No hosts yet.<br />Add one below.
          </div>
        )}
        {hosts.map((host) => {
          const session = sessions[host.id];
          const isSelected = host.id === selectedId;
          const lastResult = session?.lastResult;
          const isRunning = session?.isRunning ?? false;
          const lastHistory = session?.history ?? [];

          const statusColor = isRunning
            ? "#f59e0b"
            : lastResult === null
            ? "var(--text4)"
            : lastResult.success
            ? "#22c55e"
            : "#ef4444";

          const isSSHActive = isSelected && viewMode === "ssh";

          return (
            <div
              key={host.id}
              className={`rounded-lg mb-1 transition-all ${
                isSelected
                  ? "bg-[var(--bg-sel)] border border-[var(--border2)]"
                  : "hover:bg-[var(--bg3)] border border-transparent"
              }`}
            >
              {/* Host row */}
              <button
                onClick={() => onSelect(host.id)}
                className="w-full text-left px-3 pt-3 pb-2"
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`text-sm font-medium truncate ${
                      isSelected ? "text-[var(--text)]" : "text-[var(--text2)]"
                    }`}
                  >
                    {host.hostname}
                  </span>
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ml-2 ${isRunning ? "ping-pulsing" : ""}`}
                    style={{ backgroundColor: statusColor, boxShadow: `0 0 6px ${statusColor}80` }}
                  />
                </div>
                <div className="font-mono text-[11px] text-[var(--text3)] mb-2">{host.ip}</div>
                {lastHistory.length > 0 ? (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-[var(--text4)]">
                      {lastResult?.success
                        ? formatLatency(lastResult.latency_ms ?? 0)
                        : "FAIL"}
                    </span>
                    <MiniBar history={lastHistory} />
                  </div>
                ) : (
                  <div className="text-[11px] text-[var(--text5)]">not pinged</div>
                )}
              </button>

              {/* SSH quick-connect button (shown when host is selected) */}
              {isSelected && (
                <div className="px-3 pb-2.5 flex gap-1">
                  <button
                    onClick={() => onSelect(host.id)}
                    className={`flex-1 flex items-center justify-center gap-1 py-1 rounded-md text-[10px] font-medium transition-all ${
                      viewMode === "ping"
                        ? "bg-[#00c8a818] text-[#00c8a8] border border-[#00c8a820]"
                        : "text-[var(--text4)] hover:text-[var(--text3)] hover:bg-[var(--border)]"
                    }`}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                      <circle cx="4" cy="4" r="1.5" fill="currentColor" />
                      <circle cx="4" cy="4" r="3.5" stroke="currentColor" strokeWidth="0.8" strokeOpacity="0.5" />
                    </svg>
                    Ping
                  </button>
                  <button
                    onClick={() => onOpenSSH(host.id)}
                    className={`flex-1 flex items-center justify-center gap-1 py-1 rounded-md text-[10px] font-medium transition-all ${
                      isSSHActive
                        ? "bg-[#6366f118] text-[#818cf8] border border-[#6366f120]"
                        : "text-[var(--text4)] hover:text-[var(--text3)] hover:bg-[var(--border)]"
                    }`}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                      <rect x="0.5" y="1.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="0.8" />
                      <path d="M2 4l1 -1 -1 -1" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M4 4.5h2" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
                    </svg>
                    SSH
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom actions */}
      <div className="p-3 border-t border-[var(--border)] space-y-2">
        <button
          onClick={onAddHost}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-[var(--text3)] hover:text-[#00c8a8] hover:bg-[#0f1920] border border-[var(--border)] hover:border-[#00c8a820] transition-all text-xs font-medium"
        >
          <span className="text-base leading-none">+</span>
          Add Device
        </button>
        <button
          onClick={onOpenKeyManager}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[var(--text3)] hover:text-[#818cf8] hover:bg-[#6366f10a] border border-[var(--border)] hover:border-[#6366f120] transition-all text-xs font-medium"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <circle cx="3.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1" />
            <path d="M5 4.5h4M7.5 3v3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
          SSH Keys
        </button>
        <button
          onClick={onOpenShortcuts}
          title="Keyboard shortcuts (?)"
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[var(--text3)] hover:text-[#f59e0b] hover:bg-[#f59e0b0a] border border-[var(--border)] hover:border-[#f59e0b20] transition-all text-xs font-medium"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.5" y="2" width="9" height="6" rx="1" stroke="currentColor" strokeWidth="1" />
            <path d="M2 4h1M4 4h1M6 4h1M8 4h0M3 6h4" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
          </svg>
          Shortcuts
        </button>

        {/* Theme toggle */}
        <button
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all border border-transparent hover:border-[var(--border)]"
          style={{ color: "var(--text3)" }}
        >
          <span className="text-[11px] font-medium">
            {theme === "dark" ? "Dark mode" : "Light mode"}
          </span>
          <span className="flex items-center gap-1.5">
            {theme === "dark"
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.8"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
            }
          </span>
        </button>

        {/* Version / update indicator */}
        <button
          onClick={onOpenUpdate}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all group"
          style={updateAvailable
            ? { background: "#00c8a808", border: "1px solid #00c8a820" }
            : { border: "1px solid transparent" }
          }
        >
          <span className="text-[10px] font-mono text-[var(--text5)] group-hover:text-[var(--text3)] transition-colors">
            v{currentVersion ?? "…"}
          </span>
          {updateAvailable && (
            <span className="flex items-center gap-1 text-[10px] text-[#00c8a8]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00c8a8]" style={{ boxShadow: "0 0 4px #00c8a8" }} />
              update
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}
