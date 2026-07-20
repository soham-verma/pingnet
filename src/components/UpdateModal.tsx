import { open } from "@tauri-apps/plugin-shell";
import { UpdateInfo } from "../hooks/useUpdateCheck";

interface Props {
  update: UpdateInfo;
  onClose: () => void;
}

const BUMP_LABEL: Record<string, string> = {
  major: "MAJOR",
  minor: "MINOR",
  patch: "PATCH",
};
const BUMP_COLOR: Record<string, string> = {
  major: "#ef4444",
  minor: "#f59e0b",
  patch: "#22c55e",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export default function UpdateModal({ update, onClose }: Props) {
  const ver = update.latestVersion?.replace(/^v/, "") ?? "";
  const cur = update.currentVersion ?? "";
  const bump = update.bump ?? "patch";
  const hasNotes = update.releaseNotes.length > 0;
  const busy = update.downloading || update.installed;

  const pct = update.progress?.total
    ? Math.min(100, Math.round((update.progress.downloaded / update.progress.total) * 100))
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        className="w-full max-w-sm rounded-2xl overflow-hidden"
        style={{
          background: "linear-gradient(160deg, #12121e 0%, #0e0e1a 100%)",
          border: "1px solid var(--border)",
          boxShadow: "0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03)",
        }}
      >
        {/* Header */}
        <div className="px-6 pt-7 pb-5 text-center border-b border-[var(--border)]">
          <p className="text-[10px] tracking-[0.2em] text-[var(--text3)] uppercase mb-2">Software Update</p>
          {/* Version comparison — shows exactly what is being compared */}
          <div className="flex items-center justify-center gap-2 font-mono text-[11px]">
            <span className="text-[var(--text4)]">{cur || "—"}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-40">
              <path d="M2 6h8M6 2l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ color: BUMP_COLOR[bump] }}>{ver || "—"}</span>
          </div>
        </div>

        {/* Icon + headline */}
        <div className="flex flex-col items-center px-6 pt-6 pb-4">
          {/* Animated ring icon */}
          <div className="relative w-16 h-16 mb-5">
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 64 64">
              {/* Background ring */}
              <circle cx="32" cy="32" r="28" fill="none" stroke="var(--border)" strokeWidth="3" />
              {/* Animated progress ring */}
              <circle
                cx="32" cy="32" r="28"
                fill="none"
                stroke="#00c8a8"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray="175.9"
                strokeDashoffset="44"
                transform="rotate(-90 32 32)"
                style={{
                  filter: "drop-shadow(0 0 6px #00c8a880)",
                  animation: busy ? "spin-fast 1s linear infinite" : "spin-slow 3s linear infinite",
                }}
              />
            </svg>
            {/* Center icon */}
            <div
              className="absolute inset-0 flex items-center justify-center rounded-full"
              style={{ margin: "10px", background: "var(--bg1)", border: "1px solid var(--border)" }}
            >
              <svg width="26" height="26" viewBox="0 0 200 200" fill="none">
                <path d="M 80,148 L 80,64 C 80,44 96,36 112,36 C 138,36 148,60 148,86 C 148,110 132,124 110,124 L 90,124"
                  stroke="#00c8a8" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="80" cy="148" r="10" fill="#00c8a8"/>
              </svg>
            </div>
          </div>

          {update.installed ? (
            <>
              <h2 className="text-[var(--text)] text-lg font-semibold mb-1">Installed — restarting…</h2>
              <p className="text-[var(--text3)] text-[13px] text-center">Pingnet {ver} will open in a moment.</p>
            </>
          ) : update.downloading ? (
            <>
              <h2 className="text-[var(--text)] text-lg font-semibold mb-1">Downloading update…</h2>
              <p className="text-[var(--text3)] text-[13px] text-center">
                {pct !== null
                  ? `${pct}%${update.progress?.total ? ` · ${formatBytes(update.progress.downloaded)} / ${formatBytes(update.progress.total)}` : ""}`
                  : update.progress ? formatBytes(update.progress.downloaded) : "Starting…"}
              </p>
            </>
          ) : (
            <>
              <h2 className="text-[var(--text)] text-lg font-semibold mb-1">A new version is available.</h2>
              <p className="text-[var(--text3)] text-[13px] text-center">
                Pingnet {ver} will download and install automatically.
              </p>
            </>
          )}
        </div>

        {/* Progress bar while downloading */}
        {update.downloading && (
          <div className="mx-4 mb-4">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg1)" }}>
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: pct !== null ? `${pct}%` : "35%",
                  background: "#00c8a8",
                  boxShadow: "0 0 8px #00c8a880",
                  animation: pct === null ? "indeterminate 1.2s ease-in-out infinite" : undefined,
                }}
              />
            </div>
          </div>
        )}

        {/* Error */}
        {update.error && (
          <div className="mx-4 mb-4 rounded-xl px-4 py-3" style={{ background: "#ef444412", border: "1px solid #ef444440" }}>
            <p className="text-[12px] text-[#ef4444]">{update.error}</p>
          </div>
        )}

        {/* Release notes */}
        {!busy && hasNotes && (
          <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)]">
              <span className="text-[10px] tracking-[0.15em] text-[var(--text3)] uppercase">
                What's new in {ver}
              </span>
              <span
                className="text-[9px] font-bold px-2 py-0.5 rounded tracking-wider uppercase"
                style={{ color: BUMP_COLOR[bump], background: `${BUMP_COLOR[bump]}18` }}
              >
                {BUMP_LABEL[bump]}
              </span>
            </div>
            <div className="px-4 py-3 space-y-3">
              {update.releaseNotes.map((n, i) => (
                <div key={i} className="flex gap-2.5">
                  <span className="mt-1 w-1 h-1 rounded-full bg-[#00c8a8] flex-shrink-0" style={{ marginTop: "6px" }} />
                  <div>
                    <p className="text-[12px] text-[var(--text)] font-medium leading-snug">{n.title}</p>
                    {n.detail && (
                      <p className="text-[11px] text-[var(--text3)] leading-snug mt-0.5">{n.detail}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No notes fallback */}
        {!busy && !hasNotes && !update.error && (
          <div className="mx-4 mb-4 rounded-xl px-4 py-3 text-center" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
            <p className="text-[11px] text-[var(--text4)]">See the full changelog on GitHub.</p>
          </div>
        )}

        {/* Buttons */}
        {!busy && (
          <div className="px-4 pb-4 flex gap-2">
            <button
              onClick={() => update.installUpdate()}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all"
              style={{
                background: "#00c8a8",
                color: "#000",
                boxShadow: "0 0 24px #00c8a840",
              }}
            >
              {update.error ? "Try Again" : "Update Now"}
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 7h8M7 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              onClick={() => { update.skipVersion(); onClose(); }}
              className="flex-1 py-3 rounded-xl text-sm font-medium text-[var(--text3)] hover:text-[var(--text)] transition-colors"
              style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}
            >
              Remind Me Later
            </button>
          </div>
        )}

        {/* Manual fallback link — only surfaced if the in-app path failed */}
        {update.error && (
          <button
            onClick={() => open(update.releaseUrl)}
            className="w-full text-center text-[11px] text-[var(--text4)] hover:text-[var(--text3)] pb-4 transition-colors"
          >
            Or download it manually from GitHub →
          </button>
        )}

        {/* Footer */}
        {!update.error && (
          <p className="text-center text-[10px] text-[var(--text5)] pb-4 px-4">
            {busy
              ? "Please keep Pingnet open until this finishes."
              : "Downloads, verifies, and installs in place — Pingnet will restart automatically."}
          </p>
        )}
      </div>

      <style>{`
        @keyframes spin-slow {
          from { transform: rotate(-90deg); transform-origin: 32px 32px; }
          to   { transform: rotate(270deg); transform-origin: 32px 32px; }
        }
        @keyframes spin-fast {
          from { transform: rotate(-90deg); transform-origin: 32px 32px; }
          to   { transform: rotate(270deg); transform-origin: 32px 32px; }
        }
        @keyframes indeterminate {
          0% { margin-left: -35%; }
          100% { margin-left: 100%; }
        }
      `}</style>
    </div>
  );
}
