import { HostState } from "../types";
import { PingSession } from "../hooks/usePing";
import { formatLatency } from "../utils/network";

interface Props {
  hosts: HostState[];
  selectedId: string | null;
  sessions: Record<string, PingSession>;
  viewMode: "ping" | "ssh";
  onSelect: (id: string) => void;
  onOpenSSH: (id: string) => void;
  onAddHost: () => void;
  onOpenKeyManager: () => void;
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

export default function Sidebar({ hosts, selectedId, sessions, viewMode, onSelect, onOpenSSH, onAddHost, onOpenKeyManager }: Props) {
  return (
    <aside className="w-56 flex-shrink-0 flex flex-col h-full border-r border-[#1e1e35]" style={{ background: "#0a0a14" }}>
      {/* Header */}
      <div className="px-5 pt-8 pb-4">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="3" fill="#00c8a8" />
            <circle cx="8" cy="8" r="6" stroke="#00c8a8" strokeWidth="1" strokeOpacity="0.4" />
            <circle cx="8" cy="8" r="9" stroke="#00c8a8" strokeWidth="1" strokeOpacity="0.15" />
          </svg>
          <span className="text-[11px] font-semibold tracking-[0.2em] text-[#8892a4] uppercase">
            Pingboard
          </span>
        </div>
      </div>

      {/* Host list */}
      <div className="flex-1 overflow-y-auto px-2">
        {hosts.length === 0 && (
          <div className="px-3 py-6 text-center text-[#4b5563] text-xs">
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
            ? "#374151"
            : lastResult.success
            ? "#22c55e"
            : "#ef4444";

          const isSSHActive = isSelected && viewMode === "ssh";

          return (
            <div
              key={host.id}
              className={`rounded-lg mb-1 transition-all ${
                isSelected
                  ? "bg-[#161625] border border-[#252545]"
                  : "hover:bg-[#111120] border border-transparent"
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
                      isSelected ? "text-white" : "text-[#c4cdd8]"
                    }`}
                  >
                    {host.hostname}
                  </span>
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ml-2 ${isRunning ? "ping-pulsing" : ""}`}
                    style={{ backgroundColor: statusColor, boxShadow: `0 0 6px ${statusColor}80` }}
                  />
                </div>
                <div className="font-mono text-[11px] text-[#4b5563] mb-2">{host.ip}</div>
                {lastHistory.length > 0 ? (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-[#374151]">
                      {lastResult?.success
                        ? formatLatency(lastResult.latency_ms ?? 0)
                        : "FAIL"}
                    </span>
                    <MiniBar history={lastHistory} />
                  </div>
                ) : (
                  <div className="text-[11px] text-[#2d3748]">not pinged</div>
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
                        : "text-[#374151] hover:text-[#4b5563] hover:bg-[#1e1e35]"
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
                        : "text-[#374151] hover:text-[#4b5563] hover:bg-[#1e1e35]"
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
      <div className="p-3 border-t border-[#1e1e35] space-y-2">
        <button
          onClick={onAddHost}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-[#4b5563] hover:text-[#00c8a8] hover:bg-[#0f1920] border border-[#1e1e35] hover:border-[#00c8a820] transition-all text-xs font-medium"
        >
          <span className="text-base leading-none">+</span>
          Add Device
        </button>
        <button
          onClick={onOpenKeyManager}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[#4b5563] hover:text-[#818cf8] hover:bg-[#6366f10a] border border-[#1e1e35] hover:border-[#6366f120] transition-all text-xs font-medium"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <circle cx="3.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1" />
            <path d="M5 4.5h4M7.5 3v3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
          SSH Keys
        </button>
      </div>
    </aside>
  );
}
