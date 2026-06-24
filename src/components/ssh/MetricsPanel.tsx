import { useEffect, useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  MetricsSnapshot, Capabilities,
  CoreStat, NetIface, DiskIo, ThermalZone, GpuStat, ProcessEntry,
} from "../../types";

interface Props {
  sessionId: string;
  isActive: boolean;
}

// ── Tiny helpers ───────────────────────────────────────────────────────────────

function fmt1(n: number) { return n.toFixed(1); }
function fmt2(n: number) { return n.toFixed(2); }

function fmtKbps(kbps: number): string {
  if (kbps < 1024) return `${fmt1(kbps)} KB/s`;
  return `${fmt2(kbps / 1024)} MB/s`;
}

function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pctColor(pct: number, warn = 70, crit = 90): string {
  if (pct >= crit) return "#ef4444";
  if (pct >= warn) return "#f59e0b";
  return "#6366f1";
}

function tempColor(c: number): string {
  if (c >= 85) return "#ef4444";
  if (c >= 70) return "#f59e0b";
  return "#22c55e";
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function GaugeBar({ value, max = 100, color }: { value: number; max?: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="w-full h-1.5 rounded-full bg-[#1e1e35] overflow-hidden">
      <div className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function StatCard({
  label, value, sub, bar, barMax, barColor, unavailable,
}: {
  label: string; value: string; sub?: string;
  bar?: number; barMax?: number; barColor?: string;
  unavailable?: string | null;
}) {
  return (
    <div className={`bg-[#080810] border rounded-xl p-4 space-y-2 ${unavailable ? "border-[#1e1e35] opacity-50" : "border-[#1e1e35]"}`}>
      <p className="text-[10px] tracking-widest text-[#4b5563] uppercase">{label}</p>
      {unavailable ? (
        <p className="text-xs text-[#374151] italic">{unavailable}</p>
      ) : (
        <>
          <p className="text-2xl font-semibold text-white font-mono">{value}</p>
          {sub && <p className="text-xs text-[#4b5563]">{sub}</p>}
          {bar !== undefined && barColor && (
            <GaugeBar value={bar} max={barMax} color={barColor} />
          )}
        </>
      )}
    </div>
  );
}

function SectionHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-2 mt-4 mb-2">
      <p className="text-[10px] tracking-widest text-[#4b5563] uppercase">{title}</p>
      {badge && (
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#1e1e35] text-[#6366f1] font-mono">{badge}</span>
      )}
      <div className="flex-1 h-px bg-[#1e1e35]" />
    </div>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <p className="text-xs text-[#374151] italic py-1">
      Not available: <span className="font-mono">{reason}</span>
    </p>
  );
}

// ── Platform badge ─────────────────────────────────────────────────────────────

function PlatformBadge({ m }: { m: MetricsSnapshot }) {
  const label = m.model || m.arch;
  const color = m.model.toLowerCase().includes("jetson")
    ? "#76b900"
    : m.model.toLowerCase().includes("raspberry")
    ? "#c51a4a"
    : "#6366f1";
  return (
    <div className="flex items-center gap-2 flex-wrap mb-3">
      <span className="text-[10px] px-2 py-1 rounded-md font-mono border"
        style={{ color, borderColor: `${color}40`, background: `${color}10` }}>
        {label}
      </span>
      <span className="text-[10px] text-[#374151] font-mono">{m.kernel}</span>
      {m.is_first_poll && (
        <span className="text-[10px] text-[#f59e0b]">⚡ First poll — rates update next cycle</span>
      )}
    </div>
  );
}

// ── CPU cores ─────────────────────────────────────────────────────────────────

function CpuCores({ cores }: { cores: CoreStat[] }) {
  if (!cores.length) return null;
  return (
    <div className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${Math.min(cores.length, 8)}, 1fr)` }}>
      {cores.map((c) => {
        const color = pctColor(c.percent);
        return (
          <div key={c.index} className="bg-[#080810] border border-[#1e1e35] rounded-lg p-2 space-y-1">
            <p className="text-[9px] text-[#4b5563] text-center">cpu{c.index}</p>
            <GaugeBar value={c.percent} color={color} />
            <p className="text-[9px] font-mono text-center" style={{ color }}>{fmt1(c.percent)}%</p>
          </div>
        );
      })}
    </div>
  );
}

// ── Network I/O ───────────────────────────────────────────────────────────────

function NetTable({ ifaces }: { ifaces: NetIface[] }) {
  if (!ifaces.length) return <Unavailable reason="No active interfaces detected" />;
  return (
    <div className="space-y-1">
      {ifaces.map((i) => (
        <div key={i.name} className="flex items-center gap-3 bg-[#080810] border border-[#1e1e35] rounded-lg px-3 py-2">
          <span className="font-mono text-[11px] text-white w-16 flex-shrink-0">{i.name}</span>
          <div className="flex-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-[#22c55e]">▼</span>
              <GaugeBar value={Math.min(i.rx_kbps, 10240)} max={10240} color="#22c55e" />
              <span className="text-[10px] font-mono text-[#22c55e] w-20 flex-shrink-0">{fmtKbps(i.rx_kbps)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-[#6366f1]">▲</span>
              <GaugeBar value={Math.min(i.tx_kbps, 10240)} max={10240} color="#6366f1" />
              <span className="text-[10px] font-mono text-[#6366f1] w-20 flex-shrink-0">{fmtKbps(i.tx_kbps)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Disk I/O ──────────────────────────────────────────────────────────────────

function DiskTable({ disks }: { disks: DiskIo[] }) {
  if (!disks.length) return <Unavailable reason="No disk I/O data (idle or /proc/diskstats unavailable)" />;
  return (
    <div className="space-y-1">
      {disks.map((d) => (
        <div key={d.name} className="flex items-center gap-3 bg-[#080810] border border-[#1e1e35] rounded-lg px-3 py-2">
          <span className="font-mono text-[11px] text-white w-16 flex-shrink-0">{d.name}</span>
          <div className="flex-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-[#06b6d4]">R</span>
              <GaugeBar value={Math.min(d.read_kbps, 102400)} max={102400} color="#06b6d4" />
              <span className="text-[10px] font-mono text-[#06b6d4] w-20 flex-shrink-0">{fmtKbps(d.read_kbps)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-[#8b5cf6]">W</span>
              <GaugeBar value={Math.min(d.write_kbps, 102400)} max={102400} color="#8b5cf6" />
              <span className="text-[10px] font-mono text-[#8b5cf6] w-20 flex-shrink-0">{fmtKbps(d.write_kbps)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Thermal ───────────────────────────────────────────────────────────────────

function ThermalGrid({ zones }: { zones: ThermalZone[] }) {
  if (!zones.length) return <Unavailable reason="/sys/class/thermal not available" />;
  return (
    <div className="grid grid-cols-3 gap-2">
      {zones.map((z) => {
        const color = tempColor(z.temp_c);
        return (
          <div key={z.name} className="bg-[#080810] border border-[#1e1e35] rounded-lg p-2 space-y-1">
            <p className="text-[9px] text-[#4b5563] truncate">{z.name}</p>
            <p className="text-base font-mono font-semibold" style={{ color }}>{z.temp_c.toFixed(1)}°C</p>
          </div>
        );
      })}
    </div>
  );
}

// ── GPU ───────────────────────────────────────────────────────────────────────

const GPU_VENDOR_COLOR: Record<string, string> = {
  nvidia: "#76b900",
  jetson: "#76b900",
  amd:    "#ed1c24",
  rpi:    "#c51a4a",
};

function GpuCard({ gpu }: { gpu: GpuStat }) {
  const color = GPU_VENDOR_COLOR[gpu.vendor] ?? "#6366f1";
  return (
    <div className="bg-[#080810] border border-[#1e1e35] rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase"
          style={{ color, background: `${color}15` }}>
          {gpu.vendor}
        </span>
        <span className="text-sm text-white font-medium">{gpu.name}</span>
      </div>

      {gpu.util_pct !== null ? (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-[#4b5563]">
            <span>GPU Utilisation</span>
            <span className="font-mono" style={{ color: pctColor(gpu.util_pct) }}>
              {fmt1(gpu.util_pct)}%
            </span>
          </div>
          <GaugeBar value={gpu.util_pct} color={pctColor(gpu.util_pct)} />
        </div>
      ) : (
        <p className="text-xs text-[#374151] italic">Utilisation not available</p>
      )}

      <div className="grid grid-cols-3 gap-3 text-center">
        {gpu.mem_used_mb !== null && gpu.mem_total_mb !== null && (
          <div>
            <p className="text-[9px] text-[#4b5563] uppercase">VRAM</p>
            <p className="text-xs font-mono text-white">{gpu.mem_used_mb} / {gpu.mem_total_mb} MB</p>
          </div>
        )}
        {gpu.temp_c !== null && (
          <div>
            <p className="text-[9px] text-[#4b5563] uppercase">Temp</p>
            <p className="text-xs font-mono" style={{ color: tempColor(gpu.temp_c) }}>
              {gpu.temp_c.toFixed(1)}°C
            </p>
          </div>
        )}
        {gpu.power_w !== null && (
          <div>
            <p className="text-[9px] text-[#4b5563] uppercase">Power</p>
            <p className="text-xs font-mono text-white">{gpu.power_w.toFixed(1)} W</p>
          </div>
        )}
      </div>

      {gpu.note && (
        <p className="text-[10px] text-[#374151] italic">{gpu.note}</p>
      )}
    </div>
  );
}

// ── Process table ─────────────────────────────────────────────────────────────

function ProcessTable({ procs }: { procs: ProcessEntry[] }) {
  if (!procs.length) return <Unavailable reason="ps not available on this system" />;
  return (
    <div className="rounded-xl border border-[#1e1e35] overflow-hidden">
      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-[#4b5563] border-b border-[#1e1e35]" style={{ background: "#080810" }}>
            <th className="text-left px-3 py-2 font-normal">User</th>
            <th className="text-right px-3 py-2 font-normal w-14">CPU%</th>
            <th className="text-right px-3 py-2 font-normal w-14">MEM%</th>
            <th className="text-left px-3 py-2 font-normal">Command</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((p, i) => (
            <tr key={p.pid}
              className="border-b border-[#0f0f1a] hover:bg-[#0f0f1a] transition-colors"
              style={{ background: i % 2 === 0 ? "transparent" : "#080810" }}>
              <td className="px-3 py-1.5 text-[#6b7280] truncate max-w-[80px]">{p.user}</td>
              <td className="px-3 py-1.5 text-right"
                style={{ color: p.cpu_pct > 20 ? "#f59e0b" : p.cpu_pct > 5 ? "#9ca3af" : "#374151" }}>
                {fmt1(p.cpu_pct)}
              </td>
              <td className="px-3 py-1.5 text-right text-[#4b5563]">{fmt1(p.mem_pct)}</td>
              <td className="px-3 py-1.5 text-white truncate max-w-[200px]">{p.command}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MetricsPanel({ sessionId, isActive }: Props) {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const m = await invoke<MetricsSnapshot>("get_metrics", { sessionId });
      setMetrics(m);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Probe capabilities once on mount
  useEffect(() => {
    invoke<Capabilities>("probe_capabilities", { sessionId })
      .then(setCaps)
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    if (!isActive) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      return;
    }
    fetchMetrics();
    intervalRef.current = setInterval(fetchMetrics, 3000);
    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    };
  }, [isActive, fetchMetrics]);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[#4b5563]">
        <div className="w-4 h-4 border border-[#6366f1] border-t-transparent rounded-full animate-spin" />
        <p className="text-sm">Probing system capabilities…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
        <p className="text-[#ef4444] text-sm font-mono text-center">{error}</p>
        <button onClick={fetchMetrics} className="text-xs text-[#6366f1] hover:text-[#818cf8] underline">
          Retry
        </button>
      </div>
    );
  }

  if (!metrics) return null;

  const memPct = metrics.mem_total_mb && metrics.mem_used_mb
    ? Math.round((metrics.mem_used_mb / metrics.mem_total_mb) * 100) : 0;

  const hasGpu = metrics.gpus.length > 0;
  const hasAdvanced = metrics.cores.length > 0 || metrics.net_ifaces.length > 0
    || metrics.disk_io.length > 0 || metrics.thermal.length > 0
    || hasGpu || metrics.processes.length > 0;

  // Determine what GPU options were checked
  const gpuNote = caps
    ? [
        caps.has_nvidia_smi  && "nvidia-smi",
        caps.has_tegrastats  && "tegrastats",
        caps.has_jetson_gpu_load && "jetson-gpu-load",
        caps.has_vcgencmd    && "vcgencmd",
        caps.has_rocm_smi    && "rocm-smi",
      ].filter(Boolean).join(", ")
    : null;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-1">
      {/* Platform badge */}
      <PlatformBadge m={metrics} />

      {/* ── Summary cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label="CPU"
          value={metrics.cpu_percent !== null ? `${fmt1(metrics.cpu_percent)}%` : "N/A"}
          bar={metrics.cpu_percent ?? undefined}
          barColor={metrics.cpu_percent !== null ? pctColor(metrics.cpu_percent) : undefined}
          unavailable={metrics.cpu_unavailable_reason}
        />
        <StatCard
          label="Memory"
          value={metrics.mem_total_mb !== null ? `${memPct}%` : "N/A"}
          sub={metrics.mem_used_mb !== null && metrics.mem_total_mb !== null
            ? `${metrics.mem_used_mb} / ${metrics.mem_total_mb} MB` : undefined}
          bar={memPct || undefined}
          barColor={pctColor(memPct)}
          unavailable={metrics.mem_unavailable_reason}
        />
        <StatCard
          label="Disk (/)"
          value={metrics.disk_used_pct !== null ? `${metrics.disk_used_pct}%` : "N/A"}
          sub={metrics.disk_used_gb !== null && metrics.disk_total_gb !== null
            ? `${metrics.disk_used_gb.toFixed(1)} / ${metrics.disk_total_gb.toFixed(1)} GB` : undefined}
          bar={metrics.disk_used_pct ?? undefined}
          barColor={metrics.disk_used_pct !== null ? pctColor(metrics.disk_used_pct, 80, 95) : undefined}
          unavailable={metrics.disk_unavailable_reason}
        />
        <StatCard
          label="Load avg"
          value={metrics.load_avg_1 !== null ? fmt2(metrics.load_avg_1) : "N/A"}
          sub={metrics.load_avg_5 !== null && metrics.load_avg_15 !== null
            ? `5m: ${fmt2(metrics.load_avg_5)}  15m: ${fmt2(metrics.load_avg_15)}` : undefined}
        />
      </div>

      {metrics.uptime_seconds !== null && (
        <div className="bg-[#080810] border border-[#1e1e35] rounded-xl px-4 py-2.5 flex items-center justify-between">
          <span className="text-[10px] tracking-widest text-[#4b5563] uppercase">Uptime</span>
          <span className="font-mono text-sm text-white">{fmtUptime(metrics.uptime_seconds)}</span>
        </div>
      )}

      {/* ── Advanced toggle ────────────────────────────────────────────────── */}
      {hasAdvanced && (
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-[11px] text-[#4b5563] hover:text-[#818cf8] hover:bg-[#6366f10a] border border-[#1e1e35] hover:border-[#6366f120] transition-all mt-2"
        >
          {showAdvanced ? "▲ Hide advanced" : "▼ Show advanced"}
        </button>
      )}

      {showAdvanced && (
        <>
          {/* Per-core CPU */}
          {metrics.cores.length > 0 && (
            <>
              <SectionHeader title="CPU Cores" badge={`${metrics.cores.length} cores`} />
              <CpuCores cores={metrics.cores} />
            </>
          )}

          {/* GPU */}
          <SectionHeader title="GPU" />
          {hasGpu ? (
            <div className="space-y-2">
              {metrics.gpus.map((g, i) => <GpuCard key={i} gpu={g} />)}
            </div>
          ) : (
            <Unavailable reason={
              gpuNote
                ? `No GPU detected. Checked: ${gpuNote}`
                : "No GPU tools found (nvidia-smi, tegrastats, vcgencmd, rocm-smi)"
            } />
          )}

          {/* Thermal */}
          <SectionHeader title="Temperature" />
          <ThermalGrid zones={metrics.thermal} />

          {/* Network I/O */}
          <SectionHeader title="Network I/O" />
          {caps?.proc_net_dev
            ? <NetTable ifaces={metrics.net_ifaces} />
            : <Unavailable reason="/proc/net/dev not available on this kernel" />}

          {/* Disk I/O */}
          <SectionHeader title="Disk I/O" />
          {caps?.proc_diskstats
            ? <DiskTable disks={metrics.disk_io} />
            : <Unavailable reason="/proc/diskstats not available on this kernel" />}

          {/* Processes */}
          <SectionHeader title="Top Processes" badge="by CPU" />
          <ProcessTable procs={metrics.processes} />
        </>
      )}

      <p className="text-[10px] text-[#2d3748] text-center pt-2 pb-1">
        Auto-refreshes every 3 s
      </p>
    </div>
  );
}
