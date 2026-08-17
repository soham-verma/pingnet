import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SpeedtestResult, NetIface, MetricsSnapshot } from "../../types";

interface Props {
  /** SSH session to test from. Ignored (and not required) in "local" mode. */
  sessionId: string | null;
  isActive: boolean;
  /** "remote" (default) tests the connected host over SSH; "local" tests this machine directly. */
  mode?: "remote" | "local";
}

type Phase = "idle" | "testing" | "download" | "upload" | "done" | "error";

// ── Dial geometry ────────────────────────────────────────────────────────────
// A 270° gauge with a 90° gap at the bottom — same shape as Ookla's dial.
const START_ANGLE = 135; // degrees, 0 = 3 o'clock, clockwise
const SWEEP = 270;
const SCALE_TIERS = [25, 50, 100, 250, 500, 1000];

function scaleFor(value: number): number {
  for (const tier of SCALE_TIERS) if (value <= tier * 0.92) return tier;
  return SCALE_TIERS[SCALE_TIERS.length - 1];
}

/** Animates a number from 0 up to `target` over `duration`ms with ease-out, whenever `active` flips on. */
function useCountUp(target: number, active: boolean, duration = 1300): number {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (!active) { setDisplay(0); return; }
    let raf = 0;
    const start = performance.now();
    const ease = (x: number) => 1 - Math.pow(1 - x, 3);
    function tick(now: number) {
      const p = Math.min(1, (now - start) / duration);
      setDisplay(target * ease(p));
      if (p < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, active, duration]);
  return display;
}

function Dial({
  value, active, color, label, unit, decimals = 1,
}: {
  value: number; active: boolean; color: string; label: string; unit: string; decimals?: number;
}) {
  const size = 220, r = 92, cx = size / 2, cy = size / 2;
  const max = scaleFor(value || 1);
  const displayValue = useCountUp(value, active);
  const t = Math.sqrt(Math.max(0, Math.min(displayValue, max)) / max);

  const circumference = 2 * Math.PI * r;
  const arcLen = circumference * (SWEEP / 360);
  const gapLen = circumference - arcLen;
  const dashOffset = arcLen * (1 - t);
  const needleAngle = START_ANGLE + t * SWEEP;
  const ticks = Array.from({ length: 11 }, (_, i) => i / 10);

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(${START_ANGLE} ${cx} ${cy})`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth="8"
            strokeDasharray={`${arcLen} ${gapLen}`} strokeLinecap="round" />
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="8"
            strokeDasharray={`${arcLen} ${gapLen}`} strokeDashoffset={dashOffset} strokeLinecap="round" />
        </g>
        {ticks.map((tt, i) => {
          const a = ((START_ANGLE + tt * SWEEP) * Math.PI) / 180;
          const x1 = cx + (r - 14) * Math.cos(a), y1 = cy + (r - 14) * Math.sin(a);
          const x2 = cx + (r - 6) * Math.cos(a), y2 = cy + (r - 6) * Math.sin(a);
          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="var(--text5)" strokeWidth={i % 5 === 0 ? 1.5 : 1} opacity={0.5} />
          );
        })}
        <g style={{ transformOrigin: `${cx}px ${cy}px`, transform: `rotate(${needleAngle}deg)` }}>
          <line x1={cx} y1={cy} x2={cx + r - 20} y2={cy} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
          <circle cx={cx} cy={cy} r="5" fill={color} />
        </g>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-[9px] tracking-widest text-[var(--text4)] uppercase mb-1">{label}</span>
        <span className="text-3xl font-bold font-mono tabular-nums" style={{ color }}>
          {displayValue.toFixed(decimals)}
        </span>
        <span className="text-[10px] text-[var(--text4)] mt-0.5">{unit}</span>
      </div>
    </div>
  );
}

function StatTile({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <div className="flex-1 rounded-xl p-4 text-center" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
      <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1.5">{label}</p>
      <p className="text-2xl font-bold font-mono tabular-nums" style={{ color }}>
        {value}<span className="text-xs text-[var(--text4)] ml-1 font-normal">{unit}</span>
      </p>
    </div>
  );
}

export default function Speedtest({ sessionId, isActive, mode = "remote" }: Props) {
  const isLocal = mode === "local";
  const [ifaces, setIfaces] = useState<NetIface[]>([]);
  const [iface, setIface] = useState<string>(""); // "" = auto (default route)
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<SpeedtestResult | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const timers = useRef<number[]>([]);

  // Populate the interface picker once, the first time this tab is opened.
  // Local mode has no per-interface picker — it always tests the default route.
  useEffect(() => {
    if (isLocal || !sessionId || !isActive || ifaces.length) return;
    invoke<MetricsSnapshot>("get_metrics", { sessionId })
      .then((m) => setIfaces(m.net_ifaces ?? []))
      .catch(() => {});
  }, [isLocal, sessionId, isActive, ifaces.length]);

  function clearTimers() {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  }
  useEffect(() => () => clearTimers(), []);

  async function run(force = false) {
    if (!isLocal && !sessionId) return;
    clearTimers();
    setPhase("testing");
    setResult(null);
    setStatusMsg("Checking connectivity…");
    timers.current.push(window.setTimeout(() => setStatusMsg("Testing latency…"), 2000));
    timers.current.push(window.setTimeout(() => setStatusMsg("Testing download…"), 6000));
    timers.current.push(window.setTimeout(() => setStatusMsg("Testing upload…"), 19000));

    try {
      const r = isLocal
        ? await invoke<SpeedtestResult>("run_local_speedtest", { iface: null, force })
        : await invoke<SpeedtestResult>("run_speedtest", { sessionId, iface: iface || null, force });
      clearTimers();
      setResult(r);
      if (r.error) {
        setPhase("error");
        return;
      }
      setPhase("download");
      timers.current.push(window.setTimeout(() => setPhase("upload"), 1600));
      timers.current.push(window.setTimeout(() => setPhase("done"), 3200));
    } catch (e) {
      clearTimers();
      setResult({
        interface: iface || null, connectivity_ok: false,
        download_mbps: 0, upload_mbps: 0, latency_ms: 0, jitter_ms: 0,
        server: "", error: String(e),
      });
      setPhase("error");
    }
  }

  const latencyColor = (ms: number) => (ms < 20 ? "#22c55e" : ms < 80 ? "#f59e0b" : "#ef4444");
  const isRunning = phase === "testing" || phase === "download" || phase === "upload";
  const canRun = isLocal || !!sessionId;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--border)] flex-shrink-0" style={{ background: "var(--bg1)" }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-[var(--text3)]">
          <circle cx="7" cy="7" r="5.3" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7 4.2v3l2 1.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-sm font-semibold text-[var(--text)]">Speed Test</span>
        <span className="text-[11px] text-[var(--text4)] ml-1">
          {isLocal ? "this device · via speed.cloudflare.com" : "via speed.cloudflare.com"}
        </span>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
        {/* Interface picker — remote hosts only; not shown mid-flight */}
        {!isLocal && !isRunning && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--text4)] uppercase tracking-widest">Interface</span>
            <select
              value={iface}
              onChange={(e) => setIface(e.target.value)}
              className="px-3 py-1.5 rounded-lg bg-[var(--bg1)] border border-[var(--border)] text-sm text-[var(--text2)] outline-none focus:border-[#00c8a8] transition-all"
            >
              <option value="">Auto (default route)</option>
              {ifaces.map((i) => (
                <option key={i.name} value={i.name}>{i.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Idle — big GO button */}
        {phase === "idle" && (
          <button
            onClick={() => run(false)}
            disabled={!canRun}
            className="w-36 h-36 rounded-full flex items-center justify-center text-xl font-bold tracking-wide text-black transition-transform hover:scale-105 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "#00c8a8", boxShadow: "0 8px 30px #00c8a840" }}
          >
            GO
          </button>
        )}

        {/* Testing — indeterminate spinner + phase message */}
        {phase === "testing" && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-36 h-36 rounded-full flex items-center justify-center relative">
              <div className="absolute inset-0 rounded-full border-4 border-[var(--border)]" />
              <div className="absolute inset-0 rounded-full border-4 border-transparent animate-spin"
                style={{ borderTopColor: "#00c8a8", borderRightColor: "#00c8a8" }} />
              <span className="text-[11px] text-[var(--text3)] text-center px-4">{statusMsg}</span>
            </div>
          </div>
        )}

        {/* Download reveal */}
        {phase === "download" && result && (
          <Dial value={result.download_mbps} active label="DOWNLOAD" unit="Mbps" color="#00c8a8" />
        )}

        {/* Upload reveal */}
        {phase === "upload" && result && (
          <Dial value={result.upload_mbps} active label="UPLOAD" unit="Mbps" color="#818cf8" />
        )}

        {/* Done — final results row */}
        {phase === "done" && result && (
          <div className="flex flex-col items-center gap-5 w-full max-w-md">
            <div className="flex gap-3 w-full">
              <StatTile label="Ping" value={result.latency_ms.toFixed(1)} unit="ms" color={latencyColor(result.latency_ms)} />
              <StatTile label="Download" value={result.download_mbps.toFixed(1)} unit="Mbps" color="#00c8a8" />
              <StatTile label="Upload" value={result.upload_mbps.toFixed(1)} unit="Mbps" color="#818cf8" />
            </div>
            <div className="text-[11px] text-[var(--text4)] text-center">
              Jitter {result.jitter_ms.toFixed(1)} ms · {result.interface ? `via ${result.interface}` : "via default route"} · {result.server}
            </div>
            <button
              onClick={() => run(false)}
              className="px-6 py-2.5 rounded-full text-sm font-semibold text-black transition-transform hover:scale-105"
              style={{ background: "#00c8a8", boxShadow: "0 6px 20px #00c8a840" }}
            >
              Test Again
            </button>
          </div>
        )}

        {/* Error */}
        {phase === "error" && result && (
          <div className="flex flex-col items-center gap-4 max-w-sm text-center">
            <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: "#ef444415", border: "1px solid #ef444430" }}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 6v5M10 14h.01" stroke="#ef4444" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="10" cy="10" r="8" stroke="#ef4444" strokeWidth="1.4" />
              </svg>
            </div>
            <p className="text-[13px] text-[var(--text2)]">{result.error}</p>
            <div className="flex gap-2">
              <button
                onClick={() => run(false)}
                className="px-4 py-2 rounded-lg text-[12px] font-medium text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all"
              >
                Retry
              </button>
              {!result.connectivity_ok && (
                <button
                  onClick={() => run(true)}
                  className="px-4 py-2 rounded-lg text-[12px] font-medium transition-all"
                  style={{ background: "#00c8a818", color: "#00c8a8", border: "1px solid #00c8a830" }}
                >
                  Run anyway
                </button>
              )}
            </div>
          </div>
        )}

        {!isLocal && !sessionId && phase === "idle" && (
          <p className="text-[11px] text-[var(--text5)]">Open a terminal and connect first</p>
        )}
      </div>
    </div>
  );
}
