import { TransferItem } from "../../types";

interface Props {
  transfers: TransferItem[];
  onClear: () => void;
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${pct}%`,
          background: "linear-gradient(90deg, #00c8a8, #6366f1)",
        }}
      />
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

export default function TransferQueue({ transfers, onClear }: Props) {
  const done = transfers.filter((t) => t.status === "done" || t.status === "error");
  const active = transfers.filter((t) => t.status === "running");

  if (transfers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--text5)]">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="mb-3 opacity-40">
          <path d="M16 4v16M16 20L10 14M16 20L22 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 26H28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <p className="text-sm">No transfers yet</p>
        <p className="text-[12px] mt-1 text-[#1e2d3d]">Downloads and uploads will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] flex-shrink-0" style={{ background: "var(--bg1)" }}>
        <span className="text-[11px] tracking-widest text-[var(--text3)] uppercase">
          Transfers · {transfers.length}
        </span>
        {done.length > 0 && (
          <button onClick={onClear} className="text-[11px] text-[var(--text4)] hover:text-[var(--text3)] transition-colors">
            Clear done
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {transfers.map((t) => (
          <div
            key={t.id}
            className="rounded-xl border border-[var(--border)] p-3"
            style={{ background: "var(--bg2)" }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                {/* Direction icon */}
                <div
                  className="w-6 h-6 flex items-center justify-center rounded-md flex-shrink-0"
                  style={{
                    background: t.kind === "download" ? "#00c8a818" : "#6366f118",
                  }}
                >
                  {t.kind === "download" ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M5 1v6M5 7L2 4.5M5 7L8 4.5" stroke="#00c8a8" strokeWidth="1.5" strokeLinecap="round" />
                      <path d="M1 9H9" stroke="#00c8a8" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M5 7V1M5 1L2 3.5M5 1L8 3.5" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round" />
                      <path d="M1 9H9" stroke="#6366f1" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] text-[var(--text)] font-mono truncate">{t.name}</p>
                  <p className="text-[11px] text-[var(--text4)] mt-0.5">
                    {t.kind === "download" ? "↓ Download" : "↑ Upload"}
                    {t.total_bytes > 0 &&
                      ` · ${formatBytes(t.bytes_done)} / ${formatBytes(t.total_bytes)}`}
                  </p>
                </div>
              </div>

              <div className="flex-shrink-0">
                {t.status === "running" && (
                  <span className="w-4 h-4 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin block" />
                )}
                {t.status === "done" && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="7" fill="#22c55e30" />
                    <path d="M5 8l2 2 4-4" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {t.status === "error" && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="7" fill="#ef444430" />
                    <path d="M6 6l4 4M10 6L6 10" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                )}
              </div>
            </div>

            {t.status === "running" && t.total_bytes > 0 && (
              <ProgressBar done={t.bytes_done} total={t.total_bytes} />
            )}
            {t.status === "error" && t.error && (
              <p className="mt-1.5 text-[11px] text-[#ef4444]">{t.error}</p>
            )}
            {t.status === "done" && (
              <p className="mt-1 text-[11px] text-[#22c55e]">
                {t.kind === "download" ? "Saved to ~/Downloads" : "Upload complete"}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
