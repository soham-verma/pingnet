import { useEffect, useState, useRef, useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  MetricsSnapshot, Capabilities,
  CoreStat, NetIface, DiskIo, ThermalZone, GpuStat, ProcessEntry,
  IfaceDetails, SpeedtestResult, RouteEntry,
} from "../../types";

interface Props { sessionId: string; isActive: boolean; }

// ── Helpers ────────────────────────────────────────────────────────────────────

const f1  = (n: number) => n.toFixed(1);
const f2  = (n: number) => n.toFixed(2);
const f0  = (n: number) => Math.round(n).toString();

function fmtBytes(kbps: number) {
  if (kbps <= 0)   return "0 B/s";
  if (kbps < 1024) return `${f1(kbps)} KB/s`;
  if (kbps < 1024 * 1024) return `${f2(kbps / 1024)} MB/s`;
  return `${f2(kbps / 1024 / 1024)} GB/s`;
}
function fmtUptime(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function pctColor(p: number, warn = 70, crit = 90) {
  return p >= crit ? "#ef4444" : p >= warn ? "#f59e0b" : "#00c8a8";
}
function tempColor(c: number) {
  return c >= 85 ? "#ef4444" : c >= 70 ? "#f59e0b" : "#00c8a8";
}

// ── Primitives ─────────────────────────────────────────────────────────────────

function Track({ value, max = 100, color }: { value: number; max?: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="w-full h-[3px] rounded-full overflow-hidden" style={{ background: "#ffffff08" }}>
      <div className="h-full rounded-full transition-all duration-700"
        style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}80` }} />
    </div>
  );
}

function Chip({ label, color = "var(--text3)" }: { label: string; color?: string }) {
  return (
    <span className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded"
      style={{ color, background: `${color}18`, border: `1px solid ${color}30` }}>
      {label}
    </span>
  );
}

function NA({ msg }: { msg: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-2">
      <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "#ffffff05", border: "1px solid var(--border)" }}>
        <span className="text-[var(--text5)] text-sm">—</span>
      </div>
      <p className="text-[11px] text-[var(--text5)] italic text-center max-w-[220px]">{msg}</p>
    </div>
  );
}

// ── Section: Cores ─────────────────────────────────────────────────────────────

function CoresSection({ cores }: { cores: CoreStat[] }) {
  if (!cores.length) return <NA msg="/proc/stat not available" />;
  return (
    <div className="p-4 space-y-3">
      {/* Summary row */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Cores", value: cores.length.toString() },
          { label: "Avg Load", value: `${f1(cores.reduce((a, c) => a + c.percent, 0) / cores.length)}%` },
          { label: "Peak Core", value: `${f1(Math.max(...cores.map(c => c.percent)))}%` },
        ].map((s) => (
          <div key={s.label} className="rounded-xl p-3 text-center" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1">{s.label}</p>
            <p className="text-base font-semibold font-mono text-[var(--text)]">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Per-core table */}
      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
        <div className="grid text-[9px] tracking-widest text-[var(--text5)] uppercase px-4 py-2 border-b border-[var(--border)]"
          style={{ gridTemplateColumns: "64px 1fr 48px" }}>
          <span>Core ID</span>
          <span>Load</span>
          <span className="text-right">Usage</span>
        </div>
        <div className="divide-y divide-[var(--bg2)]">
          {cores.map((c) => {
            const color = pctColor(c.percent);
            return (
              <div key={c.index} className="grid items-center px-4 py-2.5 hover:bg-white/[0.02] transition-colors"
                style={{ gridTemplateColumns: "64px 1fr 48px" }}>
                <span className="text-[11px] font-mono text-[var(--text3)]">CORE_{String(c.index).padStart(2, "0")}</span>
                <div className="pr-4">
                  <Track value={c.percent} color={color} />
                </div>
                <span className="text-right text-[11px] font-mono font-semibold" style={{ color }}>{f1(c.percent)}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Interface detail panel ────────────────────────────────────────────────────

function fmtBigBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(2)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function IfaceDetailPanel({ sessionId, iface, onClose }: {
  sessionId: string; iface: string; onClose: () => void;
}) {
  const [data, setData]   = useState<IfaceDetails | null>(null);
  const [err, setErr]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<IfaceDetails>("get_iface_details", { sessionId, iface })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setErr(String(e)); setLoading(false); });
  }, [sessionId, iface]);

  const stateColor = data?.operstate === "up" ? "#00c8a8" : data?.operstate === "down" ? "#ef4444" : "var(--text3)";

  return (
    <div className="absolute inset-0 z-10 flex flex-col overflow-hidden"
      style={{ background: "var(--bg)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]"
        style={{ background: "var(--bg1)" }}>
        <div className="flex items-center gap-2">
          <button onClick={onClose}
            className="text-[var(--text4)] hover:text-[var(--text)] transition-colors p-1 rounded"
            style={{ background: "#ffffff08" }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M7 1L2 6l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <span className="text-[11px] font-mono font-semibold text-[var(--text)]">{iface}</span>
          {data?.operstate && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider"
              style={{ color: stateColor, background: `${stateColor}18`, border: `1px solid ${stateColor}30` }}>
              {data.operstate}
            </span>
          )}
        </div>
        <span className="text-[10px] text-[var(--text5)]">Interface Details</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading && (
          <div className="flex items-center justify-center py-12 gap-2 text-[var(--text5)]">
            <div className="w-4 h-4 border border-[#00c8a8] border-t-transparent rounded-full animate-spin" />
            <span className="text-[11px]">Loading interface details…</span>
          </div>
        )}
        {err && <div className="text-[11px] text-[#ef4444] font-mono px-2">{err}</div>}
        {data && !loading && (
          <>
            {/* Identity */}
            <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
              <div className="px-4 py-2 border-b border-[var(--border)]">
                <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Identity</span>
              </div>
              <div className="divide-y divide-[var(--bg2)]">
                {[
                  { label: "MAC Address", value: data.mac ?? "—" },
                  { label: "MTU", value: data.mtu != null ? `${data.mtu} bytes` : "—" },
                  { label: "Link Speed", value: data.speed_mbps != null && data.speed_mbps > 0 ? `${data.speed_mbps} Mbps` : "N/A" },
                  { label: "Driver", value: data.driver ?? "—" },
                  { label: "Bus", value: data.bus_info ?? "—" },
                ].map(r => (
                  <div key={r.label} className="flex justify-between px-4 py-2.5">
                    <span className="text-[10px] text-[var(--text4)]">{r.label}</span>
                    <span className="text-[10px] font-mono text-[var(--text)]">{r.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* IP addresses */}
            {(data.ipv4.length > 0 || data.ipv6.length > 0) && (
              <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
                <div className="px-4 py-2 border-b border-[var(--border)]">
                  <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Addresses</span>
                </div>
                <div className="divide-y divide-[var(--bg2)]">
                  {data.ipv4.map((ip) => (
                    <div key={ip} className="flex justify-between px-4 py-2.5">
                      <span className="text-[10px] text-[var(--text4)]">IPv4</span>
                      <span className="text-[10px] font-mono" style={{ color: "#00c8a8" }}>{ip}</span>
                    </div>
                  ))}
                  {data.ipv6.map((ip) => (
                    <div key={ip} className="flex justify-between px-4 py-2.5">
                      <span className="text-[10px] text-[var(--text4)]">IPv6</span>
                      <span className="text-[10px] font-mono text-[#818cf8] truncate max-w-[180px]">{ip}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Traffic stats */}
            <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
              <div className="px-4 py-2 border-b border-[var(--border)]">
                <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Cumulative Traffic</span>
              </div>
              <div className="grid grid-cols-2 divide-x divide-[var(--border)]">
                {[
                  { label: "RX Bytes",   value: fmtBigBytes(data.rx_bytes),   color: "#00c8a8" },
                  { label: "TX Bytes",   value: fmtBigBytes(data.tx_bytes),   color: "#818cf8" },
                  { label: "RX Packets", value: data.rx_packets.toLocaleString(), color: "#00c8a8" },
                  { label: "TX Packets", value: data.tx_packets.toLocaleString(), color: "#818cf8" },
                  { label: "RX Errors",  value: data.rx_errors.toString(),    color: data.rx_errors > 0 ? "#ef4444" : "var(--text4)" },
                  { label: "TX Errors",  value: data.tx_errors.toString(),    color: data.tx_errors > 0 ? "#ef4444" : "var(--text4)" },
                  { label: "RX Dropped", value: data.rx_dropped.toString(),   color: data.rx_dropped > 0 ? "#f59e0b" : "var(--text4)" },
                  { label: "TX Dropped", value: data.tx_dropped.toString(),   color: data.tx_dropped > 0 ? "#f59e0b" : "var(--text4)" },
                ].map((s, idx) => (
                  <div key={s.label} className={`p-3 text-center ${idx % 2 === 0 && idx < 6 ? "border-b border-[var(--border)]" : idx < 6 ? "border-b border-[var(--border)]" : ""}`}>
                    <p className="text-[9px] text-[var(--text5)] uppercase tracking-wider mb-1">{s.label}</p>
                    <p className="text-[12px] font-mono font-semibold" style={{ color: s.color }}>{s.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Routing graph ─────────────────────────────────────────────────────────────

function RoutingGraph({ sessionId, ifaces }: { sessionId: string; ifaces: NetIface[] }) {
  const [routes, setRoutes]   = useState<RouteEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setErr]       = useState<string | null>(null);

  function load() {
    setLoading(true); setErr(null);
    invoke<RouteEntry[]>("get_routes", { sessionId })
      .then(r => { setRoutes(r); setLoading(false); })
      .catch(e => { setErr(String(e)); setLoading(false); });
  }

  // Derive unique interfaces from routes for the graph
  const ifaceNames = Array.from(new Set([
    ...ifaces.map(i => i.name),
    ...(routes ?? []).map(r => r.iface).filter(Boolean),
  ]));

  const defaultRoute = routes?.find(r => r.destination === "default" || r.destination === "0.0.0.0/0");

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)]">
        <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Routing Table</span>
        <button onClick={load} disabled={loading}
          className="text-[10px] font-medium px-3 py-1 rounded-lg transition-all disabled:opacity-50"
          style={{ background: "#ffffff08", color: "var(--text3)", border: "1px solid var(--border)" }}>
          {loading ? "Loading…" : routes ? "Refresh" : "Load"}
        </button>
      </div>

      {/* Visual network graph (always shown if we have route data) */}
      {routes && routes.length > 0 && (
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <svg viewBox="0 0 280 80" className="w-full" style={{ height: 80 }}>
            {/* Internet node */}
            <g transform="translate(18,40)">
              <circle r="12" fill="var(--bg1)" stroke="var(--text4)" strokeWidth="1.5"/>
              <text y="1" textAnchor="middle" dominantBaseline="middle" fontSize="7" fill="var(--text3)">WAN</text>
              <text y="22" textAnchor="middle" fontSize="6" fill="var(--text5)">internet</text>
            </g>

            {/* Gateway node */}
            {defaultRoute?.gateway && (
              <>
                <line x1="30" y1="40" x2="82" y2="40" stroke="#00c8a8" strokeWidth="1" strokeDasharray="3,2" opacity="0.5"/>
                <g transform="translate(94,40)">
                  <circle r="12" fill="var(--bg1)" stroke="#00c8a8" strokeWidth="1.5"
                    style={{ filter: "drop-shadow(0 0 4px #00c8a840)" }}/>
                  <text y="1" textAnchor="middle" dominantBaseline="middle" fontSize="6" fill="#00c8a8">GW</text>
                  <text y="22" textAnchor="middle" fontSize="5.5" fill="var(--text5)"
                    style={{ maxWidth: 50 }}>{defaultRoute.gateway.slice(0, 12)}</text>
                </g>
              </>
            )}

            {/* Interface nodes */}
            {ifaceNames.slice(0, 5).map((name, idx) => {
              const x = defaultRoute?.gateway ? 170 : 100;
              const spread = Math.min(ifaceNames.slice(0, 5).length - 1, 4);
              const spacing = 60 / Math.max(spread, 1);
              const y = 10 + idx * spacing + (spread < 2 ? 20 : 0);
              const active = ifaces.find(i => i.name === name);
              const color = active && (active.rx_kbps > 0 || active.tx_kbps > 0) ? "#818cf8" : "var(--text5)";
              return (
                <g key={name}>
                  <line x1={defaultRoute?.gateway ? 106 : 30} y1="40" x2={x - 10} y2={y}
                    stroke={color} strokeWidth="1" opacity="0.4"/>
                  <g transform={`translate(${x + 10},${y})`}>
                    <circle r="9" fill="var(--bg1)" stroke={color} strokeWidth="1.2"/>
                    <text y="0.5" textAnchor="middle" dominantBaseline="middle" fontSize="5.5" fill={color}>
                      {name.slice(0, 6)}
                    </text>
                  </g>
                  {active && (active.rx_kbps > 0 || active.tx_kbps > 0) && (
                    <text x={x + 10} y={y + 16} textAnchor="middle" fontSize="5" fill="#818cf840">
                      {fmtBytes(active.rx_kbps + active.tx_kbps)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Route table */}
      {!routes && !loading && !error && (
        <div className="px-4 py-5 text-center">
          <p className="text-[11px] text-[var(--text5)] italic">Click Load to fetch the routing table from the device</p>
        </div>
      )}
      {error && <p className="px-4 py-3 text-[11px] text-[#ef4444] italic">{error}</p>}
      {routes && (
        <>
          <div className="grid text-[9px] tracking-widest text-[var(--text5)] uppercase px-4 py-2 border-b border-[var(--border)]"
            style={{ gridTemplateColumns: "1fr 1fr 64px 32px" }}>
            <span>Destination</span>
            <span>Gateway</span>
            <span>Interface</span>
            <span className="text-right">Metric</span>
          </div>
          <div className="divide-y divide-[var(--bg2)] max-h-48 overflow-y-auto">
            {routes.map((r, idx) => {
              const isDefault = r.destination === "default" || r.destination === "0.0.0.0/0";
              return (
                <div key={idx} className="grid items-center px-4 py-2 hover:bg-white/[0.02] transition-colors"
                  style={{ gridTemplateColumns: "1fr 1fr 64px 32px" }}>
                  <span className={`text-[10px] font-mono truncate ${isDefault ? "font-semibold" : ""}`}
                    style={{ color: isDefault ? "#00c8a8" : "var(--text2)" }}>
                    {r.destination || "—"}
                  </span>
                  <span className="text-[10px] font-mono text-[var(--text3)] truncate pr-2">
                    {r.gateway || "—"}
                  </span>
                  <span className="text-[10px] font-mono text-[#818cf8]">{r.iface}</span>
                  <span className="text-right text-[10px] font-mono text-[var(--text5)]">
                    {r.metric ?? "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Speedtest card ────────────────────────────────────────────────────────────

function SpeedtestCard({ sessionId }: { sessionId: string }) {
  const [phase, setPhase]   = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<SpeedtestResult | null>(null);
  const [statusMsg, setStatusMsg] = useState("");

  async function run() {
    setPhase("running");
    setResult(null);
    setStatusMsg("Testing latency…");
    // Simulate phase messages (actual work is server-side, ~30s total)
    const timer1 = setTimeout(() => setStatusMsg("Testing download…"), 5000);
    const timer2 = setTimeout(() => setStatusMsg("Testing upload…"), 18000);
    try {
      const r = await invoke<SpeedtestResult>("run_speedtest", { sessionId });
      clearTimeout(timer1); clearTimeout(timer2);
      if (r.error) { setPhase("error"); setStatusMsg(r.error); }
      else { setResult(r); setPhase("done"); }
    } catch (e) {
      clearTimeout(timer1); clearTimeout(timer2);
      setPhase("error"); setStatusMsg(String(e));
    }
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Cloudflare Speedtest</span>
          <Chip label="Remote" color="#f59e0b" />
        </div>
        {phase !== "running" && (
          <button onClick={run}
            className="text-[10px] font-medium px-3 py-1 rounded-lg transition-all"
            style={{ background: "#00c8a818", color: "#00c8a8", border: "1px solid #00c8a830" }}>
            {phase === "idle" ? "Run Test" : "Re-run"}
          </button>
        )}
        {phase === "running" && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 border border-[#00c8a8] border-t-transparent rounded-full animate-spin" />
            <span className="text-[10px] text-[#00c8a8]">{statusMsg}</span>
          </div>
        )}
      </div>

      {phase === "error" && (
        <div className="px-4 py-3">
          <p className="text-[11px] text-[#ef4444] italic">{statusMsg}</p>
          <p className="text-[10px] text-[var(--text5)] mt-1">Requires curl on the remote device with internet access.</p>
        </div>
      )}

      {phase === "done" && result && (
        <div className="grid grid-cols-2 divide-x divide-y divide-[var(--border)]">
          {[
            { label: "Download",  value: `${result.download_mbps.toFixed(1)}`, unit: "Mbps", color: "#00c8a8" },
            { label: "Upload",    value: `${result.upload_mbps.toFixed(1)}`,   unit: "Mbps", color: "#818cf8" },
            { label: "Latency",   value: `${result.latency_ms.toFixed(1)}`,    unit: "ms",   color: result.latency_ms < 20 ? "#22c55e" : result.latency_ms < 80 ? "#f59e0b" : "#ef4444" },
            { label: "Jitter",    value: `${result.jitter_ms.toFixed(1)}`,     unit: "ms",   color: result.jitter_ms < 5 ? "#22c55e" : "#f59e0b" },
          ].map((s) => (
            <div key={s.label} className="p-4 text-center">
              <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1">{s.label}</p>
              <p className="text-xl font-semibold font-mono" style={{ color: s.color }}>
                {s.value}<span className="text-xs text-[var(--text4)] ml-0.5">{s.unit}</span>
              </p>
            </div>
          ))}
        </div>
      )}

      {phase === "idle" && (
        <div className="px-4 py-4 text-center">
          <p className="text-[11px] text-[var(--text5)] italic">Tests download, upload and latency from the remote device to speed.cloudflare.com</p>
        </div>
      )}
    </div>
  );
}

// ── Section: Network ──────────────────────────────────────────────────────────

type NetSort = "name" | "rx" | "tx" | "total";
const NET_SORT_KEY = "pingnet_net_sort";

function NetworkSection({ ifaces, available, sessionId }: { ifaces: NetIface[]; available: boolean; sessionId: string }) {
  const [sortBy, setSortBy]           = useState<NetSort>(() => (localStorage.getItem(NET_SORT_KEY) as NetSort) ?? "rx");
  const [selectedIface, setSelected]  = useState<string | null>(null);
  const [showSpeedtest, setSpeedtest] = useState(false);

  if (!available) return <NA msg="/proc/net/dev not available on this kernel" />;
  if (!ifaces.length) return <NA msg="No active interfaces" />;

  const changeSortBy = (s: NetSort) => { setSortBy(s); localStorage.setItem(NET_SORT_KEY, s); };

  const totalRx = ifaces.reduce((a, i) => a + i.rx_kbps, 0);
  const totalTx = ifaces.reduce((a, i) => a + i.tx_kbps, 0);

  const sorted = [...ifaces].sort((a, b) => {
    switch (sortBy) {
      case "name":  return a.name.localeCompare(b.name);
      case "rx":    return b.rx_kbps - a.rx_kbps;
      case "tx":    return b.tx_kbps - a.tx_kbps;
      case "total": return (b.rx_kbps + b.tx_kbps) - (a.rx_kbps + a.tx_kbps);
    }
  });

  return (
    <div className="relative flex flex-col h-full">
      {/* Interface detail overlay */}
      {selectedIface && (
        <IfaceDetailPanel sessionId={sessionId} iface={selectedIface} onClose={() => setSelected(null)} />
      )}

      <div className="p-4 space-y-3">
        {/* Totals */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl p-4" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1">Total Download</p>
            <p className="text-xl font-semibold font-mono" style={{ color: "#00c8a8" }}>{fmtBytes(totalRx)}</p>
            <div className="mt-2"><Track value={totalRx} max={Math.max(totalRx * 1.2, 1)} color="#00c8a8" /></div>
          </div>
          <div className="rounded-xl p-4" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1">Total Upload</p>
            <p className="text-xl font-semibold font-mono" style={{ color: "#818cf8" }}>{fmtBytes(totalTx)}</p>
            <div className="mt-2"><Track value={totalTx} max={Math.max(totalTx * 1.2, 1)} color="#818cf8" /></div>
          </div>
        </div>

        {/* Interface table */}
        <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
          {/* Table header with sort controls */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)]">
            <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Interfaces</span>
            <div className="flex items-center gap-1">
              {(["name","rx","tx","total"] as NetSort[]).map((s) => (
                <button key={s} onClick={() => changeSortBy(s)}
                  className="text-[9px] font-medium px-2 py-0.5 rounded transition-all uppercase tracking-wider"
                  style={sortBy === s
                    ? { color: "#00c8a8", background: "#00c8a818", border: "1px solid #00c8a830" }
                    : { color: "var(--text4)", background: "transparent", border: "1px solid transparent" }
                  }>
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-[var(--bg2)]">
            {sorted.map((i) => {
              const active = i.rx_kbps > 0 || i.tx_kbps > 0;
              return (
                <button key={i.name}
                  onClick={() => setSelected(i.name)}
                  className="w-full text-left hover:bg-white/[0.025] transition-colors group"
                >
                  <div className="grid items-center px-4 py-3" style={{ gridTemplateColumns: "80px 1fr 1fr 32px" }}>
                    <div>
                      <p className="text-[11px] font-mono text-[var(--text)] font-medium">{i.name}</p>
                      <Chip label={active ? "Active" : "Idle"} color={active ? "#00c8a8" : "var(--text4)"} />
                    </div>
                    <div className="pr-3 space-y-1">
                      <span className="text-[10px] font-mono" style={{ color: "#00c8a8" }}>↓ {fmtBytes(i.rx_kbps)}</span>
                      <Track value={i.rx_kbps} max={Math.max(totalRx, 1)} color="#00c8a8" />
                    </div>
                    <div className="pr-2 space-y-1">
                      <span className="text-[10px] font-mono" style={{ color: "#818cf8" }}>↑ {fmtBytes(i.tx_kbps)}</span>
                      <Track value={i.tx_kbps} max={Math.max(totalTx, 1)} color="#818cf8" />
                    </div>
                    {/* Chevron */}
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
                      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <path d="M2 1l3 3-3 3" stroke="var(--text3)" strokeWidth="1.2" strokeLinecap="round"/>
                    </svg>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Routing graph */}
        <RoutingGraph sessionId={sessionId} ifaces={ifaces} />

        {/* Speedtest */}
        <div>
          {!showSpeedtest
            ? <button onClick={() => setSpeedtest(true)}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-[11px] font-medium transition-all text-[var(--text4)] hover:text-[#00c8a8] hover:bg-[#00c8a808]"
                style={{ border: "1px dashed var(--border)" }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1"/>
                  <path d="M5 3v2l1.5 1.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                </svg>
                Run Cloudflare Speedtest
              </button>
            : <SpeedtestCard sessionId={sessionId} />
          }
        </div>
      </div>
    </div>
  );
}

// ── Section: Disk ─────────────────────────────────────────────────────────────

function DiskSection({ disks, available, usedPct, usedGb, totalGb, diskUnavail }: {
  disks: DiskIo[]; available: boolean;
  usedPct: number | null; usedGb: number | null; totalGb: number | null; diskUnavail: string | null;
}) {
  const freeGb = totalGb !== null && usedGb !== null ? totalGb - usedGb : null;
  const color = usedPct !== null ? pctColor(usedPct, 80, 95) : "var(--text3)";

  return (
    <div className="p-4 space-y-3">
      {/* Storage card */}
      <div className="rounded-xl p-4" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Storage (/)</span>
          {usedPct !== null && <span className="text-2xl font-semibold font-mono" style={{ color }}>{usedPct}%</span>}
        </div>
        {diskUnavail
          ? <p className="text-[11px] text-[var(--text4)] italic">{diskUnavail}</p>
          : <>
              <Track value={usedPct ?? 0} color={color} />
              <div className="grid grid-cols-3 gap-2 mt-3">
                {[
                  { label: "Total", value: totalGb !== null ? `${totalGb.toFixed(1)} GB` : "—" },
                  { label: "Used",  value: usedGb  !== null ? `${usedGb.toFixed(1)} GB`  : "—", color },
                  { label: "Free",  value: freeGb  !== null ? `${freeGb.toFixed(1)} GB`  : "—", color: "#22c55e" },
                ].map((s) => (
                  <div key={s.label} className="text-center p-2 rounded-lg" style={{ background: "#ffffff04", border: "1px solid var(--border)" }}>
                    <p className="text-[9px] text-[var(--text5)] uppercase tracking-wider mb-1">{s.label}</p>
                    <p className="text-[13px] font-mono font-semibold" style={{ color: s.color ?? "#ffffff" }}>{s.value}</p>
                  </div>
                ))}
              </div>
            </>
        }
      </div>

      {/* I/O */}
      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)]">
          <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Disk I/O</span>
          {!available && <span className="text-[10px] text-[var(--text4)] italic">/proc/diskstats unavailable</span>}
        </div>
        {!available || !disks.length
          ? <div className="px-4 py-4 text-center text-[11px] text-[var(--text5)] italic">
              {!available ? "Kernel does not expose /proc/diskstats" : "No disk activity"}
            </div>
          : <div className="divide-y divide-[var(--bg2)]">
              {disks.map((d) => (
                <div key={d.name} className="px-4 py-3 hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-mono text-[var(--text)]">{d.name}</span>
                    <div className="flex gap-3">
                      <span className="text-[10px] font-mono" style={{ color: "#06b6d4" }}>R {fmtBytes(d.read_kbps)}</span>
                      <span className="text-[10px] font-mono" style={{ color: "#8b5cf6" }}>W {fmtBytes(d.write_kbps)}</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Track value={d.read_kbps} max={Math.max(d.read_kbps + d.write_kbps, 1)} color="#06b6d4" />
                    <Track value={d.write_kbps} max={Math.max(d.read_kbps + d.write_kbps, 1)} color="#8b5cf6" />
                  </div>
                </div>
              ))}
            </div>
        }
      </div>
    </div>
  );
}

// ── Section: GPU ──────────────────────────────────────────────────────────────

const GPU_COLOR: Record<string, string> = { nvidia: "#76b900", jetson: "#76b900", amd: "#ed1c24", rpi: "#c51a4a" };

function GpuSection({ gpus, checkedTools }: { gpus: GpuStat[]; checkedTools: string }) {
  if (!gpus.length) return (
    <div className="p-4">
      <div className="rounded-xl p-6 text-center" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
        <p className="text-[var(--text4)] text-xs italic mb-1">No GPU detected</p>
        {checkedTools && <p className="text-[9px] text-[var(--text5)] font-mono">Checked: {checkedTools}</p>}
      </div>
    </div>
  );

  return (
    <div className="p-4 space-y-3">
      {gpus.map((g, i) => {
        const color = GPU_COLOR[g.vendor] ?? "#6366f1";
        const vramPct = g.mem_used_mb && g.mem_total_mb ? Math.round(g.mem_used_mb / g.mem_total_mb * 100) : null;
        return (
          <div key={i} className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
            {/* GPU header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold tracking-widest uppercase px-2 py-0.5 rounded"
                  style={{ color, background: `${color}18`, border: `1px solid ${color}30` }}>
                  {g.vendor}
                </span>
                <span className="text-[12px] text-[var(--text)] font-medium">{g.name}</span>
              </div>
              {g.note && <span className="text-[10px] text-[var(--text4)] italic">{g.note}</span>}
            </div>

            {/* Main metrics row */}
            <div className="grid grid-cols-3 divide-x divide-[var(--border)]">
              <div className="p-4 text-center">
                <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1">GPU Load</p>
                {g.util_pct !== null
                  ? <>
                      <p className="text-2xl font-semibold font-mono" style={{ color: pctColor(g.util_pct) }}>
                        {f1(g.util_pct)}<span className="text-sm">%</span>
                      </p>
                      <div className="mt-2"><Track value={g.util_pct} color={pctColor(g.util_pct)} /></div>
                    </>
                  : <p className="text-[11px] text-[var(--text4)] italic mt-2">N/A</p>
                }
              </div>
              <div className="p-4 text-center">
                <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1">Temperature</p>
                {g.temp_c !== null
                  ? <p className="text-2xl font-semibold font-mono" style={{ color: tempColor(g.temp_c) }}>
                      {f0(g.temp_c)}<span className="text-sm">°C</span>
                    </p>
                  : <p className="text-[11px] text-[var(--text4)] italic mt-2">N/A</p>
                }
              </div>
              <div className="p-4 text-center">
                <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1">Power Draw</p>
                {g.power_w !== null
                  ? <p className="text-2xl font-semibold font-mono text-[var(--text)]">
                      {f0(g.power_w)}<span className="text-sm">W</span>
                    </p>
                  : <p className="text-[11px] text-[var(--text4)] italic mt-2">N/A</p>
                }
              </div>
            </div>

            {/* VRAM */}
            {g.mem_used_mb !== null && g.mem_total_mb !== null && (
              <div className="px-4 pb-4">
                <div className="rounded-lg p-3" style={{ background: "#ffffff04", border: "1px solid var(--border)" }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">VRAM Allocation</span>
                    <div className="flex gap-3 text-[10px] font-mono">
                      <span style={{ color }}>{g.mem_used_mb} MB used</span>
                      <span className="text-[var(--text5)]">/</span>
                      <span className="text-[var(--text3)]">{g.mem_total_mb} MB total</span>
                    </div>
                  </div>
                  <Track value={g.mem_used_mb} max={g.mem_total_mb} color={color} />
                  <div className="grid grid-cols-3 gap-2 mt-2 text-center">
                    {[
                      { label: "In Use",     value: `${g.mem_used_mb} MB`,                       col: color },
                      { label: "Available",  value: `${g.mem_total_mb - g.mem_used_mb} MB`,       col: "#22c55e" },
                      { label: "Load",       value: vramPct !== null ? `${vramPct}%` : "—",       col: pctColor(vramPct ?? 0) },
                    ].map((s) => (
                      <div key={s.label}>
                        <p className="text-[9px] text-[var(--text5)] uppercase tracking-wider">{s.label}</p>
                        <p className="text-[11px] font-mono font-semibold" style={{ color: s.col }}>{s.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Section: Temperature ──────────────────────────────────────────────────────

function TempSection({ zones }: { zones: ThermalZone[] }) {
  if (!zones.length) return <NA msg="/sys/class/thermal not available on this system" />;

  const maxTemp = Math.max(...zones.map(z => z.temp_c));
  const avgTemp = zones.reduce((a, z) => a + z.temp_c, 0) / zones.length;

  return (
    <div className="p-4 space-y-3">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Peak",    value: `${f0(maxTemp)}°C`, color: tempColor(maxTemp) },
          { label: "Average", value: `${f1(avgTemp)}°C`, color: tempColor(avgTemp) },
          { label: "Sensors", value: zones.length.toString(), color: "var(--text3)" },
        ].map((s) => (
          <div key={s.label} className="rounded-xl p-3 text-center" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1">{s.label}</p>
            <p className="text-xl font-semibold font-mono" style={{ color: s.color }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Thermal zones table */}
      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
        <div className="grid text-[9px] tracking-widest text-[var(--text5)] uppercase px-4 py-2 border-b border-[var(--border)]"
          style={{ gridTemplateColumns: "1fr 80px 48px" }}>
          <span>Sensor</span>
          <span>Waveform</span>
          <span className="text-right">Temp</span>
        </div>
        <div className="divide-y divide-[var(--bg2)]">
          {zones.map((z) => {
            const color = tempColor(z.temp_c);
            // 20°C = 0%, 100°C = 100%
            const pct = Math.min(100, Math.max(0, (z.temp_c - 20) / 80 * 100));
            return (
              <div key={z.name} className="grid items-center px-4 py-3 hover:bg-white/[0.02] transition-colors"
                style={{ gridTemplateColumns: "1fr 80px 48px" }}>
                <span className="text-[11px] font-mono text-[var(--text3)] truncate pr-2">{z.name}</span>
                <div className="pr-4">
                  <Track value={pct} color={color} />
                </div>
                <span className="text-right text-[12px] font-mono font-semibold" style={{ color }}>
                  {f0(z.temp_c)}°
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Section: Processes ────────────────────────────────────────────────────────

type ProcSort = "cpu" | "mem" | "pid" | "name";

function SortArrow({ dir }: { dir: "asc" | "desc" }) {
  return (
    <svg width="6" height="5" viewBox="0 0 6 5" fill="currentColor" style={{ flexShrink: 0 }}>
      {dir === "desc"
        ? <path d="M3 5L0 0h6L3 5z" />
        : <path d="M3 0l3 5H0L3 0z" />
      }
    </svg>
  );
}

function ProcessesSection({ procs, osType }: { procs: ProcessEntry[]; osType: string }) {
  const [sortBy, setSortBy]   = useState<ProcSort>("cpu");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function handleSort(col: ProcSort) {
    if (sortBy === col) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortBy(col);
      // Numeric cols default descending; name/pid default ascending
      setSortDir(col === "name" ? "asc" : "desc");
    }
  }

  if (!procs.length) return <NA msg="Process list unavailable on this system" />;

  const totalCpu = procs.reduce((a, p) => a + p.cpu_pct, 0);
  const totalMem = procs.reduce((a, p) => a + p.mem_pct, 0);

  const sorted = [...procs].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case "cpu":  cmp = a.cpu_pct - b.cpu_pct; break;
      case "mem":  cmp = a.mem_pct - b.mem_pct; break;
      case "pid":  cmp = a.pid - b.pid; break;
      case "name": cmp = a.command.localeCompare(b.command); break;
    }
    return sortDir === "desc" ? -cmp : cmp;
  });

  // On Windows, cpu_pct is CPU time in seconds (not %)
  const isWindows = osType === "windows";
  const cpuUnit   = isWindows ? "s" : "%";

  function ColHeader({ col, label, className = "" }: { col: ProcSort; label: string; className?: string }) {
    const active = sortBy === col;
    return (
      <button
        onClick={() => handleSort(col)}
        className={`flex items-center gap-1 text-[9px] tracking-widest uppercase transition-colors select-none ${className}`}
        style={{ color: active ? "#00c8a8" : "var(--text5)" }}
        title={`Sort by ${label}`}
      >
        {label}
        {active && <SortArrow dir={sortDir} />}
      </button>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: isWindows ? "CPU Time" : "CPU Usage", value: isWindows ? `${f1(totalCpu)}s` : `${f1(Math.min(totalCpu, 100))}%`, color: pctColor(Math.min(totalCpu, 100)) },
          { label: "Memory Load",  value: `${f1(Math.min(totalMem, 100))}%`, color: pctColor(totalMem) },
          { label: "Active Tasks", value: procs.length.toString(), color: "var(--text3)" },
        ].map((s) => (
          <div key={s.label} className="rounded-xl p-3 text-center" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
            <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase mb-1">{s.label}</p>
            <p className="text-xl font-semibold font-mono" style={{ color: s.color }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Process table */}
      <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
        {/* Clickable column headers */}
        <div className="grid items-center px-4 py-2 border-b border-[var(--border)]"
          style={{ gridTemplateColumns: "1fr 56px 72px 56px" }}>
          <ColHeader col="name" label="Process" className="justify-start" />
          <ColHeader col="pid"  label="PID"     className="justify-end" />
          <ColHeader col="cpu"  label={`CPU (${cpuUnit})`} className="justify-end" />
          <ColHeader col="mem"  label="MEM"     className="justify-end" />
        </div>

        <div className="divide-y divide-[var(--bg2)]">
          {sorted.map((p) => {
            const cpuColor = p.cpu_pct > (isWindows ? 60 : 50) ? "#ef4444"
              : p.cpu_pct > (isWindows ? 20 : 20) ? "#f59e0b"
              : "var(--text3)";
            const isHot = p.cpu_pct > (isWindows ? 60 : 50);
            return (
              <div key={p.pid}
                className="grid items-center px-4 py-2.5 hover:bg-white/[0.02] transition-colors"
                style={{ gridTemplateColumns: "1fr 56px 72px 56px" }}>
                <div className="min-w-0 pr-2">
                  <p className="text-[11px] font-mono text-[var(--text)] truncate">{p.command}</p>
                  <p className="text-[10px] text-[var(--text5)]">{p.user}</p>
                </div>
                <span className="text-right text-[10px] font-mono text-[var(--text4)]">{p.pid}</span>
                <span className="text-right">
                  {isHot
                    ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                        style={{ color: "#ef4444", background: "#ef444418", border: "1px solid #ef444430" }}>
                        {f1(p.cpu_pct)}{cpuUnit}
                      </span>
                    : <span className="text-[10px] font-mono" style={{ color: cpuColor }}>{f1(p.cpu_pct)}{cpuUnit}</span>
                  }
                </span>
                <span className="text-right text-[10px] font-mono text-[var(--text4)]">{f1(p.mem_pct)}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

type Section = "cores" | "network" | "disk" | "gpu" | "temp" | "processes";

export default function MetricsPanel({ sessionId, isActive }: Props) {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [caps, setCaps]       = useState<Capabilities | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<Section>("cores");
  const [pulse, setPulse]     = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Logging state ────────────────────────────────────────────────────────
  const [logging, setLogging]   = useState(false);
  const logBufRef  = useRef<{ ts: number; snapshot: MetricsSnapshot }[]>([]);
  const loggingRef = useRef(false);   // mirrors `logging` without being a dep
  const [logCount, setLogCount] = useState(0);
  const LOG_CAP = 3600; // ~3 hours at 3 s interval

  // Keep ref in sync so fetchMetrics never needs to re-subscribe to `logging`
  useEffect(() => { loggingRef.current = logging; }, [logging]);

  const fetchMetrics = useCallback(async () => {
    try {
      const m = await invoke<MetricsSnapshot>("get_metrics", { sessionId });
      setMetrics(m);
      setError(null);
      setPulse(true);
      setTimeout(() => setPulse(false), 300);
      // Append to log buffer if recording — read the ref, not the state value,
      // so toggling logging does NOT recreate the interval (task #8).
      if (loggingRef.current) {
        if (logBufRef.current.length >= LOG_CAP) {
          // Drop oldest entry to stay within cap (task #9)
          logBufRef.current.shift();
        }
        logBufRef.current.push({ ts: Date.now(), snapshot: m });
        setLogCount(logBufRef.current.length);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]); // `logging` intentionally omitted — use loggingRef instead

  useEffect(() => {
    invoke<Capabilities>("probe_capabilities", { sessionId }).then(setCaps).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    if (!isActive) { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; } return; }
    fetchMetrics();
    intervalRef.current = setInterval(fetchMetrics, 3000);
    return () => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; } };
  }, [isActive, fetchMetrics]);

  if (loading) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--text5)]">
      <div className="w-5 h-5 border border-[#00c8a8] border-t-transparent rounded-full animate-spin" style={{ boxShadow: "0 0 12px #00c8a840" }} />
      <p className="text-[11px] tracking-widest uppercase">Probing system</p>
    </div>
  );

  if (error) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
      <p className="text-[#ef4444] text-xs font-mono text-center">{error}</p>
      <button onClick={fetchMetrics} className="text-[11px] text-[#00c8a8] hover:text-[var(--text)] underline">Retry</button>
    </div>
  );

  if (!metrics) return null;

  const memPct = metrics.mem_total_mb && metrics.mem_used_mb
    ? Math.round(metrics.mem_used_mb / metrics.mem_total_mb * 100) : 0;

  const platformColor = metrics.model.toLowerCase().includes("jetson") ? "#76b900"
    : metrics.model.toLowerCase().includes("raspberry") ? "#c51a4a" : "#6366f1";

  const checkedGpuTools = caps ? [
    caps.has_nvidia_smi && "nvidia-smi", caps.has_tegrastats && "tegrastats",
    caps.has_jetson_gpu_load && "jetson-gpu", caps.has_vcgencmd && "vcgencmd", caps.has_rocm_smi && "rocm-smi",
  ].filter(Boolean).join(", ") : "";

  const tabs: { id: Section; label: string; alert?: boolean }[] = [
    { id: "cores",     label: "Cores" },
    { id: "network",   label: "Network" },
    { id: "disk",      label: "Disk" },
    { id: "gpu",       label: "GPU",  alert: metrics.gpus.length > 0 },
    { id: "temp",      label: "Temp", alert: metrics.thermal.some(z => z.temp_c >= 70) },
    { id: "processes", label: "Procs" },
  ];

  const summaryItems = [
    {
      label: "CPU",
      value: metrics.cpu_percent !== null ? `${f1(metrics.cpu_percent)}` : "—",
      unit: "%",
      pct: metrics.cpu_percent ?? 0,
      color: metrics.cpu_percent !== null ? pctColor(metrics.cpu_percent) : "var(--text5)",
      unavail: metrics.cpu_unavailable_reason,
    },
    {
      label: "Memory",
      value: memPct ? `${memPct}` : "—",
      unit: "%",
      sub: metrics.mem_used_mb && metrics.mem_total_mb ? `${metrics.mem_used_mb}/${metrics.mem_total_mb} MB` : undefined,
      pct: memPct,
      color: pctColor(memPct),
      unavail: metrics.mem_unavailable_reason,
    },
    {
      label: "Disk",
      value: metrics.disk_used_pct !== null ? `${metrics.disk_used_pct}` : "—",
      unit: "%",
      sub: metrics.disk_total_gb ? `${metrics.disk_total_gb.toFixed(0)} GB total` : undefined,
      pct: metrics.disk_used_pct ?? 0,
      color: metrics.disk_used_pct !== null ? pctColor(metrics.disk_used_pct, 80, 95) : "var(--text5)",
      unavail: metrics.disk_unavailable_reason,
    },
    {
      label: "Load",
      value: metrics.load_avg_1 !== null ? f2(metrics.load_avg_1) : "—",
      unit: "",
      sub: metrics.load_avg_5 !== null ? `5m ${f2(metrics.load_avg_5)}` : undefined,
      pct: 0,
      color: "#818cf8",
      unavail: null,
      noBar: true,
    },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: "var(--bg)" }}>

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between border-b border-[var(--border)]"
        style={{ background: "var(--bg1)" }}>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono" style={{ color: platformColor }}>
            {metrics.model || metrics.arch}
          </span>
          <span className="text-[var(--border)]">·</span>
          <span className="text-[10px] font-mono text-[var(--text5)]">{metrics.kernel}</span>
        </div>
        <div className="flex items-center gap-2">
          {metrics.is_first_poll && (
            <span className="text-[10px] text-[#f59e0b]">⚡ next poll</span>
          )}
          {metrics.uptime_seconds !== null && (
            <span className="text-[10px] font-mono text-[var(--text5)]">up {fmtUptime(metrics.uptime_seconds)}</span>
          )}

          {/* Logging controls */}
          {!logging && logCount === 0 && (
            <button onClick={() => { logBufRef.current = []; setLogCount(0); setLogging(true); }}
              className="flex items-center gap-1 text-[9px] font-medium px-2 py-1 rounded transition-all text-[var(--text4)] hover:text-[#ef4444]"
              style={{ border: "1px solid var(--border)" }}>
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--text4)]" />
              Record
            </button>
          )}
          {logging && (
            <button onClick={() => setLogging(false)}
              className="flex items-center gap-1 text-[9px] font-medium px-2 py-1 rounded transition-all"
              style={{ color: "#ef4444", background: "#ef444412", border: "1px solid #ef444430" }}>
              <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444] animate-pulse" />
              {logCount} samples
            </button>
          )}
          {!logging && logCount > 0 && (
            <div className="flex items-center gap-1">
              <button onClick={async () => {
                // Tauri WebView doesn't support anchor-click downloads.
                // Open a native Save dialog, then write via Rust.
                const defaultName = `pingnet-metrics-${sessionId}-${Date.now()}.json`;
                const path = await save({
                  defaultPath: defaultName,
                  filters: [{ name: "JSON", extensions: ["json"] }],
                }).catch(() => null);
                if (!path) return; // user cancelled
                const json = JSON.stringify(logBufRef.current, null, 2);
                try {
                  await invoke("write_text_file", { path, content: json });
                  setError(null);
                } catch (e) {
                  setError(`Export failed: ${String(e)}`);
                }
              }}
                className="text-[9px] font-medium px-2 py-1 rounded transition-all"
                style={{ color: "#00c8a8", background: "#00c8a812", border: "1px solid #00c8a830" }}>
                ↓ Export {logCount}
              </button>
              <button
                onClick={() => { logBufRef.current = []; setLogCount(0); setLogging(true); }}
                className="text-[9px] font-medium px-2 py-1 rounded transition-all text-[var(--text4)] hover:text-[#ef4444]"
                style={{ border: "1px solid var(--border)" }}
                title="Discard and re-record">
                ↺ Re-record
              </button>
            </div>
          )}

          {/* Live pulse dot */}
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full transition-all duration-300"
              style={{ background: pulse ? "#00c8a8" : "#1e2e2a", boxShadow: pulse ? "0 0 6px #00c8a8" : "none" }} />
            <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Live</span>
          </div>
        </div>
      </div>

      {/* ── Summary cards ──────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 grid grid-cols-4 gap-px border-b border-[var(--border)]" style={{ background: "var(--border)" }}>
        {summaryItems.map((s) => (
          <div key={s.label} className="p-4 flex flex-col gap-2" style={{ background: "var(--bg1)" }}>
            <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">{s.label}</span>
            {s.unavail
              ? <span className="text-[10px] text-[var(--text5)] italic leading-tight">{s.unavail}</span>
              : <>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-2xl font-semibold font-mono leading-none" style={{ color: s.color }}>{s.value}</span>
                    {s.unit && <span className="text-sm text-[var(--text4)]">{s.unit}</span>}
                  </div>
                  {s.sub && <span className="text-[10px] font-mono text-[var(--text5)]">{s.sub}</span>}
                  {!s.noBar && <Track value={s.pct} color={s.color} />}
                </>
            }
          </div>
        ))}
      </div>

      {/* ── Section tabs ───────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center gap-0 border-b border-[var(--border)] overflow-x-auto"
        style={{ background: "var(--bg1)" }}>
        {tabs.map((t) => (
          <button key={t.id}
            onClick={() => setSection(t.id)}
            className="relative flex items-center gap-1.5 px-4 py-3 text-[11px] font-medium transition-all flex-shrink-0"
            style={section === t.id
              ? { color: "#fff", borderBottom: "2px solid #00c8a8" }
              : { color: "var(--text4)", borderBottom: "2px solid transparent" }
            }
          >
            {t.label}
            {t.alert && (
              <span className="w-1 h-1 rounded-full" style={{ background: "#00c8a8", boxShadow: "0 0 4px #00c8a8" }} />
            )}
          </button>
        ))}
      </div>

      {/* ── Section content ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {section === "cores"     && <CoresSection cores={metrics.cores} />}
        {section === "network"   && <NetworkSection ifaces={metrics.net_ifaces} available={caps?.proc_net_dev ?? true} sessionId={sessionId} />}
        {section === "disk"      && <DiskSection disks={metrics.disk_io} available={caps?.proc_diskstats ?? true}
                                      usedPct={metrics.disk_used_pct} usedGb={metrics.disk_used_gb}
                                      totalGb={metrics.disk_total_gb} diskUnavail={metrics.disk_unavailable_reason} />}
        {section === "gpu"       && <GpuSection gpus={metrics.gpus} checkedTools={checkedGpuTools} />}
        {section === "temp"      && <TempSection zones={metrics.thermal} />}
        {section === "processes" && <ProcessesSection procs={metrics.processes} osType={metrics.os_type} />}
      </div>
    </div>
  );
}
