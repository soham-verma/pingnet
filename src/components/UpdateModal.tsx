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

export default function UpdateModal({ update, onClose }: Props) {
  const ver = update.latestVersion?.replace(/^v/, "") ?? "";
  const cur = update.currentVersion ?? "";
  const bump = update.bump ?? "patch";
  const hasNotes = update.releaseNotes.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-sm rounded-2xl overflow-hidden"
        style={{
          background: "linear-gradient(160deg, #12121e 0%, #0e0e1a 100%)",
          border: "1px solid #1e1e35",
          boxShadow: "0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03)",
        }}
      >
        {/* Header */}
        <div className="px-6 pt-7 pb-5 text-center border-b border-[#1e1e35]">
          <p className="text-[10px] tracking-[0.2em] text-[#4b5563] uppercase mb-1">Software Update</p>
          <p className="text-[11px] text-[#2d3748] font-mono">Version {cur} (Stable)</p>
        </div>

        {/* Icon + headline */}
        <div className="flex flex-col items-center px-6 pt-6 pb-4">
          {/* Animated ring icon */}
          <div className="relative w-16 h-16 mb-5">
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 64 64">
              {/* Background ring */}
              <circle cx="32" cy="32" r="28" fill="none" stroke="#1e1e35" strokeWidth="3" />
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
                  animation: "spin-slow 3s linear infinite",
                }}
              />
            </svg>
            {/* Center icon */}
            <div
              className="absolute inset-0 flex items-center justify-center rounded-full"
              style={{ margin: "10px", background: "#0a0a14", border: "1px solid #1e1e35" }}
            >
              <svg width="26" height="26" viewBox="0 0 200 200" fill="none">
                <path d="M 80,148 L 80,64 C 80,44 96,36 112,36 C 138,36 148,60 148,86 C 148,110 132,124 110,124 L 90,124"
                  stroke="#00c8a8" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="80" cy="148" r="10" fill="#00c8a8"/>
              </svg>
            </div>
          </div>

          <h2 className="text-white text-lg font-semibold mb-1">A new version is available.</h2>
          <p className="text-[#4b5563] text-[13px] text-center">
            Pingnet {ver} is ready to download.
          </p>
        </div>

        {/* Release notes */}
        {hasNotes && (
          <div className="mx-4 mb-4 rounded-xl overflow-hidden" style={{ background: "#0a0a14", border: "1px solid #1e1e35" }}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1e1e35]">
              <span className="text-[10px] tracking-[0.15em] text-[#4b5563] uppercase">
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
                    <p className="text-[12px] text-white font-medium leading-snug">{n.title}</p>
                    {n.detail && (
                      <p className="text-[11px] text-[#4b5563] leading-snug mt-0.5">{n.detail}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* No notes fallback */}
        {!hasNotes && (
          <div className="mx-4 mb-4 rounded-xl px-4 py-3 text-center" style={{ background: "#0a0a14", border: "1px solid #1e1e35" }}>
            <p className="text-[11px] text-[#374151]">See the full changelog on GitHub.</p>
          </div>
        )}

        {/* Buttons */}
        <div className="px-4 pb-4 flex gap-2">
          <button
            onClick={() => open(update.releaseUrl)}
            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all"
            style={{
              background: "#00c8a8",
              color: "#000",
              boxShadow: "0 0 24px #00c8a840",
            }}
          >
            Update Now
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 7h8M7 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            onClick={() => { update.skipVersion(); onClose(); }}
            className="flex-1 py-3 rounded-xl text-sm font-medium text-[#4b5563] hover:text-white transition-colors"
            style={{ background: "#0a0a14", border: "1px solid #1e1e35" }}
          >
            Remind Me Later
          </button>
        </div>

        {/* Footer */}
        <p className="text-center text-[10px] text-[#2d3748] pb-4 px-4">
          Opens the GitHub releases page to download the installer.
        </p>
      </div>

      <style>{`
        @keyframes spin-slow {
          from { transform: rotate(-90deg); transform-origin: 32px 32px; }
          to   { transform: rotate(270deg); transform-origin: 32px 32px; }
        }
      `}</style>
    </div>
  );
}
