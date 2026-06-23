import { PingHistoryEntry } from "../hooks/usePing";

interface Props {
  history: PingHistoryEntry[];
  avg: number | null;
  max: number | null;
}

export default function LatencyChart({ history, avg, max }: Props) {
  const slots = 30;
  const padded = Array(Math.max(0, slots - history.length))
    .fill(null)
    .concat(history.slice(-slots));

  const maxVal = Math.max(...history.map((h) => h.latency ?? 0), 10);

  return (
    <div className="rounded-xl border border-[#1e1e35] p-5" style={{ background: "#0f0f1a" }}>
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] tracking-widest text-[#4b5563] uppercase">
          Latency History
        </span>
        <div className="flex items-center gap-4 text-[11px] text-[#4b5563]">
          {avg !== null && (
            <span>
              AVG <span className="text-[#00c8a8] font-mono ml-1">{Math.round(avg)}</span>
            </span>
          )}
          {max !== null && (
            <span>
              MAX <span className="text-[#f59e0b] font-mono ml-1">{Math.round(max)}</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex items-end gap-[3px] h-16">
        {padded.map((entry, i) => {
          if (!entry) {
            return (
              <div
                key={i}
                className="flex-1 rounded-sm"
                style={{ height: "4px", backgroundColor: "#1e1e35" }}
              />
            );
          }
          const isActive = i === padded.length - 1;
          const barH = entry.success && entry.latency
            ? Math.max(6, (entry.latency / maxVal) * 64)
            : 4;

          const color = !entry.success
            ? "#ef4444"
            : isActive
            ? "#00e5c4"
            : "#00c8a8";

          return (
            <div
              key={i}
              className="flex-1 rounded-sm transition-all"
              style={{
                height: `${barH}px`,
                backgroundColor: color,
                opacity: 0.5 + (i / slots) * 0.5,
                boxShadow: isActive ? `0 0 8px ${color}` : undefined,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
