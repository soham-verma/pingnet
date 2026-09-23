import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_SCAN_PORTS, isQuietRow, mergePortRows, parsePortSpec,
  type ListeningSocket, type PortRow, type PortScanResult, type PortVerdict,
} from "../utils/ports";

// ── Backend types ─────────────────────────────────────────────────────────────

interface PtrEntry { ip: string; name: string | null }
interface HostnameInfo { input: string; addresses: string[]; ptr: PtrEntry[]; error: string | null }
interface DeviceNetIdentity {
  hostname: string | null;
  fqdn: string | null;
  public_ip: string | null;
  public_ptr: string | null;
}

interface Props {
  /** Primary address/hostname of the device (what ping / SSH use) */
  target: string;
  /** Additional addresses to reverse-resolve (reference IPs) */
  extraTargets?: string[];
  /** Connected SSH session — enables device-side hostname, public IP and listening ports */
  sessionId: string | null;
  /** Shown as a shortcut when there's no SSH session */
  onOpenSSH?: () => void;
}

const CYAN = "#00c8a8";

const VERDICT: Record<PortVerdict, { label: string; color: string; hint: string }> = {
  "active":      { label: "Active",          color: "#22c55e", hint: "Listening on the device and reachable from here" },
  "open":        { label: "Open",            color: CYAN,      hint: "Accepts connections from here" },
  "listening":   { label: "Listening",       color: "#818cf8", hint: "Listening on the device (not scanned from here)" },
  "local-only":  { label: "Local only",      color: "#94a3b8", hint: "Bound to loopback — only reachable on the device itself" },
  "blocked":     { label: "Listening · blocked", color: "#f59e0b", hint: "Listening on the device but not reachable from here (firewall / NAT)" },
  "closed":      { label: "Not active",      color: "var(--text4)", hint: "Nothing listening — the device refused the connection" },
  "filtered":    { label: "Filtered",        color: "var(--text4)", hint: "No reply — dropped by a firewall, or the host is down" },
  "unreachable": { label: "Unreachable",     color: "#ef4444", hint: "No route to the host from here" },
  "udp":         { label: "Listening (UDP)", color: "#818cf8", hint: "UDP socket bound on the device" },
};

const REMOTE_LABEL: Record<string, string> = {
  open: "open", closed: "refused", filtered: "no reply", unreachable: "unreachable",
};

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg overflow-hidden min-w-0" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border)]">
        <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function KV({ label, value, mono = true, color }: { label: string; value: React.ReactNode; mono?: boolean; color?: string }) {
  return (
    <div className="flex justify-between gap-3 px-3 py-2">
      <span className="text-[10px] text-[var(--text4)] flex-shrink-0">{label}</span>
      <span className={`text-[10px] text-right break-all ${mono ? "font-mono" : ""}`} style={{ color: color ?? "var(--text)" }}>
        {value}
      </span>
    </div>
  );
}

function Spinner() {
  return <div className="w-3 h-3 border border-[#00c8a8] border-t-transparent rounded-full animate-spin flex-shrink-0" />;
}

export default function NetworkInfoPanel({ target, extraTargets = [], sessionId, onOpenSSH }: Props) {
  // Guards against results from a previous target landing after a switch
  const gen = useRef(0);

  const [hostnames, setHostnames] = useState<HostnameInfo[] | null>(null);
  const [hnLoading, setHnLoading] = useState(false);

  const [identity, setIdentity] = useState<DeviceNetIdentity | null>(null);
  const [idLoading, setIdLoading] = useState(false);
  const [idErr, setIdErr]         = useState<string | null>(null);

  const [listening, setListening]       = useState<ListeningSocket[] | null>(null);
  const [listenLoading, setListenLoading] = useState(false);
  const [listenErr, setListenErr]       = useState<string | null>(null);

  const [scan, setScan]           = useState<PortScanResult | null>(null);
  const [scanning, setScanning]   = useState(false);
  const [scanErr, setScanErr]     = useState<string | null>(null);
  const [portMode, setPortMode]   = useState<"common" | "custom">("common");
  const [portSpec, setPortSpec]   = useState("");
  const [showAll, setShowAll]     = useState(false);

  const targetsKey = [target, ...extraTargets].join("|");

  const loadHostnames = useCallback(() => {
    const g = gen.current;
    const targets = Array.from(new Set([target, ...extraTargets].filter(Boolean)));
    setHnLoading(true);
    invoke<HostnameInfo[]>("lookup_hostnames", { targets })
      .then((r) => { if (g === gen.current) setHostnames(r); })
      .catch(() => { if (g === gen.current) setHostnames([]); })
      .finally(() => { if (g === gen.current) setHnLoading(false); });
  }, [targetsKey]);

  const loadDevice = useCallback(() => {
    if (!sessionId) return;
    const g = gen.current;
    setIdLoading(true); setIdErr(null);
    invoke<DeviceNetIdentity>("ssh_device_identity", { sessionId })
      .then((r) => { if (g === gen.current) setIdentity(r); })
      .catch((e) => { if (g === gen.current) setIdErr(String(e)); })
      .finally(() => { if (g === gen.current) setIdLoading(false); });

    setListenLoading(true); setListenErr(null);
    invoke<ListeningSocket[]>("ssh_listening_ports", { sessionId })
      .then((r) => { if (g === gen.current) setListening(r); })
      .catch((e) => { if (g === gen.current) setListenErr(String(e)); })
      .finally(() => { if (g === gen.current) setListenLoading(false); });
  }, [sessionId]);

  // Reset + auto-load cheap lookups whenever the device / session changes
  useEffect(() => {
    gen.current += 1;
    setHostnames(null); setIdentity(null); setIdErr(null);
    setListening(null); setListenErr(null); setScan(null); setScanErr(null);
    loadHostnames();
    loadDevice();
  }, [loadHostnames, loadDevice]);

  const customParsed = useMemo(() => parsePortSpec(portSpec), [portSpec]);
  const scanPorts = portMode === "common" ? DEFAULT_SCAN_PORTS : customParsed.ports;
  const scanDisabled = scanning || (portMode === "custom" && (!!customParsed.error || scanPorts.length === 0));

  function runScan() {
    if (scanDisabled) return;
    const g = gen.current;
    setScanning(true); setScanErr(null);
    invoke<PortScanResult>("scan_ports", { target, ports: scanPorts, timeoutMs: 800 })
      .then((r) => { if (g === gen.current) setScan(r); })
      .catch((e) => { if (g === gen.current) setScanErr(String(e)); })
      .finally(() => { if (g === gen.current) setScanning(false); });
    if (sessionId) {
      // Refresh device-side sockets alongside so both columns are current
      setListenLoading(true);
      invoke<ListeningSocket[]>("ssh_listening_ports", { sessionId })
        .then((r) => { if (g === gen.current) { setListening(r); setListenErr(null); } })
        .catch((e) => { if (g === gen.current) setListenErr(String(e)); })
        .finally(() => { if (g === gen.current) setListenLoading(false); });
    }
  }

  const rows: PortRow[] = useMemo(
    () => mergePortRows(scan?.ports ?? null, sessionId ? listening : null),
    [scan, listening, sessionId],
  );
  const visibleRows = showAll ? rows : rows.filter((r) => !isQuietRow(r));
  const hiddenCount = rows.length - visibleRows.length;
  const counts = useMemo(() => {
    const c: Partial<Record<PortVerdict, number>> = {};
    rows.forEach((r) => { c[r.verdict] = (c[r.verdict] ?? 0) + 1; });
    return c;
  }, [rows]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Network Info</span>
          <span className="text-[10px] font-mono text-[var(--text3)] truncate">{target}</span>
        </div>
        <button
          onClick={() => { loadHostnames(); loadDevice(); }}
          disabled={hnLoading || idLoading}
          className="text-[10px] font-medium px-3 py-1 rounded-lg transition-all disabled:opacity-50"
          style={{ background: "#ffffff08", color: "var(--text3)", border: "1px solid var(--border)" }}
        >
          {hnLoading || idLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Hostnames + device identity */}
      <div className="grid gap-3 p-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <Card title="Hostnames (DNS from here)" right={hnLoading ? <Spinner /> : undefined}>
          <div className="divide-y divide-[var(--bg2)]">
            {hostnames === null && !hnLoading && <KV label="—" value="—" />}
            {hostnames?.map((h) => (
              <div key={h.input} className="px-3 py-2 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10px] font-mono text-[var(--text2)] break-all">{h.input}</span>
                  {h.error && <span className="text-[10px] text-[#ef4444] text-right">{h.error}</span>}
                </div>
                {h.ptr.map((p) => (
                  <div key={p.ip} className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-mono text-[var(--text4)] break-all">
                      {p.ip !== h.input ? `→ ${p.ip}` : "PTR"}
                    </span>
                    <span className="text-[10px] font-mono text-right break-all"
                      style={{ color: p.name ? CYAN : "var(--text5)" }}>
                      {p.name ?? "no PTR record"}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Card>

        {sessionId ? (
          <Card title="Device (via SSH)" right={idLoading ? <Spinner /> : undefined}>
            {idErr ? (
              <div className="px-3 py-2 text-[10px] text-[#ef4444] font-mono break-all">{idErr}</div>
            ) : (
              <div className="divide-y divide-[var(--bg2)]">
                <KV label="Hostname" value={identity?.hostname ?? (idLoading ? "…" : "—")} />
                <KV label="FQDN" value={identity?.fqdn ?? (idLoading ? "…" : "—")} />
                <KV label="Public IP" value={identity?.public_ip ?? (idLoading ? "…" : "unavailable")}
                  color={identity?.public_ip ? CYAN : "var(--text5)"} />
                <KV label="Public hostname" value={identity?.public_ptr ?? (idLoading ? "…" : identity?.public_ip ? "no PTR record" : "—")}
                  color={identity?.public_ptr ? CYAN : "var(--text5)"} />
              </div>
            )}
          </Card>
        ) : (
          <Card title="Device (via SSH)">
            <div className="px-3 py-3 space-y-2">
              <p className="text-[10px] text-[var(--text4)] leading-relaxed">
                Connect over SSH to see the device's own hostname, its public IP / hostname, and which ports are
                actually listening on it.
              </p>
              {onOpenSSH && (
                <button onClick={onOpenSSH}
                  className="text-[10px] font-medium px-3 py-1 rounded-lg transition-all text-[#818cf8] hover:bg-[#6366f110]"
                  style={{ border: "1px solid #6366f130" }}>
                  Open SSH →
                </button>
              )}
            </div>
          </Card>
        )}
      </div>

      {/* Ports */}
      <div className="px-3 pb-3">
        <Card
          title="Ports"
          right={listenLoading ? <span className="flex items-center gap-1.5 text-[9px] text-[var(--text5)]"><Spinner />device sockets</span> : undefined}
        >
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
            <div className="flex rounded-md overflow-hidden" style={{ border: "1px solid var(--border)" }}>
              {(["common", "custom"] as const).map((m) => (
                <button key={m} onClick={() => setPortMode(m)}
                  className="text-[10px] font-medium px-2.5 py-1 transition-all"
                  style={portMode === m
                    ? { color: CYAN, background: "#00c8a818" }
                    : { color: "var(--text4)" }}>
                  {m === "common" ? `Common (${DEFAULT_SCAN_PORTS.length})` : "Custom"}
                </button>
              ))}
            </div>
            {portMode === "custom" && (
              <input
                value={portSpec}
                onChange={(e) => setPortSpec(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runScan(); }}
                placeholder="22, 80, 443, 8000-8100"
                className="flex-1 min-w-[140px] bg-[var(--bg1)] rounded-md px-2 py-1 text-[11px] font-mono text-[var(--text)] outline-none"
                style={{ border: `1px solid ${portSpec && customParsed.error ? "#ef444480" : "var(--border)"}` }}
              />
            )}
            <button
              onClick={runScan}
              disabled={scanDisabled}
              className="flex items-center gap-1.5 text-[10px] font-semibold px-3 py-1 rounded-md transition-all disabled:opacity-40"
              style={{ background: CYAN, color: "#000" }}
            >
              {scanning && <div className="w-2.5 h-2.5 border border-black border-t-transparent rounded-full animate-spin" />}
              {scanning ? "Scanning…" : scan ? "Rescan" : "Scan"}
            </button>
            <div className="flex-1" />
            {rows.length > 0 && (
              <label className="flex items-center gap-1.5 text-[10px] text-[var(--text4)] cursor-pointer select-none">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-[#00c8a8]" />
                Show not active
              </label>
            )}
          </div>

          {/* Status / errors */}
          {portMode === "custom" && portSpec && customParsed.error && (
            <p className="px-3 py-1.5 text-[10px] text-[#ef4444]">{customParsed.error}</p>
          )}
          {scanErr && <p className="px-3 py-1.5 text-[10px] text-[#ef4444] font-mono break-all">{scanErr}</p>}
          {listenErr && <p className="px-3 py-1.5 text-[10px] text-[#f59e0b] break-all">Device sockets: {listenErr}</p>}
          {(scan || rows.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-[var(--border)]">
              {scan && (
                <span className="text-[10px] text-[var(--text5)]">
                  {scan.ports.length} TCP ports on <span className="font-mono">{scan.address}</span> in {(scan.duration_ms / 1000).toFixed(1)}s
                </span>
              )}
              {(Object.keys(VERDICT) as PortVerdict[]).filter((v) => counts[v]).map((v) => (
                <span key={v} className="flex items-center gap-1 text-[10px]" style={{ color: VERDICT[v].color }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: VERDICT[v].color }} />
                  {counts[v]} {VERDICT[v].label.toLowerCase()}
                </span>
              ))}
            </div>
          )}

          {/* Table */}
          {rows.length === 0 && !scanning && !listenLoading ? (
            <p className="px-3 py-4 text-center text-[11px] text-[var(--text5)] italic">
              {sessionId
                ? "No listening sockets reported yet — run a scan to check reachability from this machine."
                : "Run a scan to check which ports are reachable on this device from this machine."}
            </p>
          ) : visibleRows.length > 0 ? (
            <>
              <div className="grid text-[9px] tracking-widest text-[var(--text5)] uppercase px-3 py-1.5 border-b border-[var(--border)]"
                style={{ gridTemplateColumns: "72px minmax(70px,1fr) 128px 92px minmax(100px,1.6fr)" }}>
                <span>Port</span><span>Service</span><span>Status</span><span>From here</span><span>On device</span>
              </div>
              <div className="divide-y divide-[var(--bg2)]">
                {visibleRows.map((r) => {
                  const v = VERDICT[r.verdict];
                  const addrs = r.listening ? Array.from(new Set(r.listening.map((s) => s.address))) : [];
                  const procs = r.listening
                    ? Array.from(new Set(r.listening.filter((s) => s.process).map((s) => s.pid ? `${s.process} (${s.pid})` : s.process!)))
                    : [];
                  return (
                    <div key={`${r.proto}:${r.port}`}
                      className="grid items-center px-3 py-2 hover:bg-white/[0.02] transition-colors"
                      style={{ gridTemplateColumns: "72px minmax(70px,1fr) 128px 92px minmax(100px,1.6fr)" }}>
                      <span className="text-[11px] font-mono text-[var(--text)]">
                        {r.port}<span className="text-[9px] text-[var(--text5)] ml-1">{r.proto}</span>
                      </span>
                      <span className="text-[10px] font-mono text-[var(--text3)] truncate pr-2">{r.service ?? "—"}</span>
                      <span title={v.hint}>
                        <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider whitespace-nowrap"
                          style={{ color: v.color, background: "rgba(127,127,127,0.08)", boxShadow: "inset 0 0 0 1px currentColor" }}>
                          {v.label}
                        </span>
                      </span>
                      <span className="text-[10px] font-mono text-[var(--text4)]">
                        {r.remote ? REMOTE_LABEL[r.remote] : "—"}
                        {r.remote === "open" && r.latency_ms != null && (
                          <span className="text-[var(--text5)]"> · {Math.round(r.latency_ms)}ms</span>
                        )}
                      </span>
                      <span className="text-[10px] font-mono text-[var(--text3)] min-w-0 break-all">
                        {r.listening === null
                          ? <span className="text-[var(--text5)]">{sessionId ? "…" : "needs SSH"}</span>
                          : addrs.length === 0
                          ? <span className="text-[var(--text5)]">not listening</span>
                          : <>
                              {addrs.join(", ")}
                              {procs.length > 0 && <span className="text-[#818cf8]"> · {procs.join(", ")}</span>}
                            </>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
          {hiddenCount > 0 && !showAll && (
            <button onClick={() => setShowAll(true)}
              className="w-full px-3 py-2 text-[10px] text-[var(--text5)] hover:text-[var(--text3)] transition-colors border-t border-[var(--border)]">
              {hiddenCount} not-active port{hiddenCount === 1 ? "" : "s"} hidden · show
            </button>
          )}
        </Card>
      </div>
    </div>
  );
}
