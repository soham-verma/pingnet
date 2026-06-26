import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface LocalNetworkInfo {
  local_ip:    string | null;
  iface_name:  string | null;
  gateway:     string | null;
  dns_servers: string[];
  dhcp:        boolean;
}

interface Props {
  ip: string;
  hostname: string;
  isRunning: boolean;
  success: boolean | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isIpAddress(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

/** Well-known DNS server names */
function dnsLabel(ip: string): string {
  if (ip.startsWith("8.8.8") || ip.startsWith("8.8.4"))  return "Google Public DNS";
  if (ip.startsWith("1.1.1") || ip.startsWith("1.0.0"))  return "Cloudflare DNS";
  if (ip.startsWith("9.9.9"))                              return "Quad9";
  if (ip.startsWith("208.67.22") || ip.startsWith("208.67.220")) return "OpenDNS";
  if (ip === "127.0.0.53" || ip === "127.0.0.1")          return "Local Resolver";
  return "DNS Server";
}

// ── sub-components ────────────────────────────────────────────────────────────

function NodeIcon({ type, color }: { type: "device" | "gateway" | "dns" | "internet" | "target"; color: string }) {
  return (
    <div
      className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
      style={{ background: `${color}18`, border: `1px solid ${color}40` }}
    >
      {type === "device" && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="3" width="14" height="9" rx="1.5" stroke={color} strokeWidth="1.3" />
          <path d="M5 12v1.5M11 12v1.5M3 14.5h10" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
          <rect x="3.5" y="5.5" width="9" height="4" rx="0.5" stroke={color} strokeWidth="1" strokeOpacity="0.5" />
        </svg>
      )}
      {type === "gateway" && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="5" width="14" height="7" rx="1.5" stroke={color} strokeWidth="1.3" />
          <circle cx="4" cy="8.5" r="1" fill={color} />
          <circle cx="7" cy="8.5" r="1" fill={color} fillOpacity="0.5" />
          <path d="M4 5V3M8 5V3M12 5V3" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )}
      {type === "dns" && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.3" />
          <path d="M8 1.5C8 1.5 11 4 11 8s-3 6.5-3 6.5M8 1.5C8 1.5 5 4 5 8s3 6.5 3 6.5" stroke={color} strokeWidth="1.3" strokeOpacity="0.6" />
          <path d="M1.5 8h13" stroke={color} strokeWidth="1.3" strokeOpacity="0.6" />
        </svg>
      )}
      {type === "internet" && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 2L14 8L8 14L2 8L8 2Z" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M8 2v12M2 8h12" stroke={color} strokeWidth="1.3" strokeOpacity="0.5" />
        </svg>
      )}
      {type === "target" && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="1" width="12" height="14" rx="1.5" stroke={color} strokeWidth="1.3" />
          <path d="M5 5.5h6M5 8h6M5 10.5h4" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.6" />
        </svg>
      )}
    </div>
  );
}

interface HopNode {
  type:    "device" | "gateway" | "dns" | "internet" | "target";
  label:   string;
  primary: string;
  secondary?: string;
  badge?:  string;
  color:   string;
}

// ── main component ────────────────────────────────────────────────────────────

export default function NetworkRoute({ ip, hostname, isRunning, success }: Props) {
  const [netInfo, setNetInfo]       = useState<LocalNetworkInfo | null>(null);
  const [packetPos, setPacketPos]   = useState(0); // 0–100 across all hops
  const animRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch local network info once on mount
  useEffect(() => {
    invoke<LocalNetworkInfo>("get_local_network_info")
      .then(setNetInfo)
      .catch(() => setNetInfo(null));
  }, []);

  // Animate the packet dot
  useEffect(() => {
    if (animRef.current) clearInterval(animRef.current);
    if (!isRunning) {
      setPacketPos(success ? 100 : 50);
      return;
    }
    setPacketPos(0);
    animRef.current = setInterval(() => {
      setPacketPos((p) => (p >= 100 ? 0 : p + 1.5));
    }, 25);
    return () => { if (animRef.current) clearInterval(animRef.current); };
  }, [isRunning, success]);

  // Build the hop list
  const needsDns = !isIpAddress(ip); // target is a hostname → DNS step visible
  const statusColor = success === null ? "var(--text4)" : success ? "#00c8a8" : "#ef4444";

  const hops: HopNode[] = [];

  // Node 1 — local device
  hops.push({
    type:      "device",
    label:     "YOUR DEVICE",
    primary:   netInfo?.local_ip ?? "detecting…",
    secondary: netInfo?.iface_name ?? undefined,
    badge:     netInfo?.dhcp ? "DHCP" : undefined,
    color:     "#6366f1",
  });

  // Node 2 — router / gateway
  hops.push({
    type:      "gateway",
    label:     "ROUTER / GATEWAY",
    primary:   netInfo?.gateway ?? (netInfo ? "not found" : "detecting…"),
    secondary: "Default route",
    color:     "#f59e0b",
  });

  // Node 3 — DNS (only when target is a hostname)
  if (needsDns && netInfo?.dns_servers && netInfo.dns_servers.length > 0) {
    const dnsIp = netInfo.dns_servers[0];
    hops.push({
      type:      "dns",
      label:     "DNS RESOLVER",
      primary:   dnsIp,
      secondary: dnsLabel(dnsIp),
      color:     "#818cf8",
    });
  } else if (needsDns) {
    hops.push({
      type:      "dns",
      label:     "DNS RESOLVER",
      primary:   netInfo ? "system default" : "detecting…",
      color:     "#818cf8",
    });
  }

  // Node 4 — target
  hops.push({
    type:      "target",
    label:     "TARGET",
    primary:   hostname !== ip ? hostname : ip,
    secondary: hostname !== ip ? ip : undefined,
    color:     statusColor === "var(--text4)" ? "#00c8a8" : statusColor,
  });

  // Packet position mapped to node index (0 → first node, 100 → last)
  const totalSegments = hops.length - 1;
  const packetNodeF   = (packetPos / 100) * totalSegments; // float index

  return (
    <div
      className="rounded-xl border border-[var(--border)] p-5 overflow-hidden relative"
      style={{ background: "var(--bg1)" }}
    >
      {/* Subtle grid background */}
      <svg className="absolute inset-0 w-full h-full opacity-[0.03]" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="nr-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#6366f1" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#nr-grid)" />
      </svg>

      <div className="relative z-10">
        <div className="flex items-center justify-between mb-4">
          <span className="text-[10px] tracking-widest text-[var(--text3)] uppercase">Network Path</span>
          {isRunning && (
            <span className="flex items-center gap-1.5 text-[11px] text-[#f59e0b]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-pulse" />
              Tracing
            </span>
          )}
          {!isRunning && success === true && (
            <span className="flex items-center gap-1.5 text-[11px] text-[#22c55e]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e]" />
              Reachable
            </span>
          )}
          {!isRunning && success === false && (
            <span className="flex items-center gap-1.5 text-[11px] text-[#ef4444]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444]" />
              Unreachable
            </span>
          )}
        </div>

        {/* Hop nodes, vertical */}
        <div className="space-y-0">
          {hops.map((hop, idx) => {
            const isLast    = idx === hops.length - 1;
            // Glow intensity: 1 at packet position, fade off
            const dist      = Math.abs(packetNodeF - idx);
            const glowAlpha = Math.max(0, 1 - dist * 1.5);

            return (
              <div key={idx}>
                {/* Node row */}
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <NodeIcon type={hop.type} color={hop.color} />
                    {/* Glow ring when packet is near */}
                    {isRunning && glowAlpha > 0.1 && (
                      <div
                        className="absolute inset-0 rounded-xl pointer-events-none"
                        style={{
                          boxShadow: `0 0 ${Math.round(glowAlpha * 12)}px ${hop.color}`,
                          opacity: glowAlpha,
                        }}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] tracking-widest font-medium" style={{ color: hop.color }}>
                        {hop.label}
                      </span>
                      {hop.badge && (
                        <span
                          className="text-[8px] px-1.5 py-0.5 rounded font-medium tracking-wide"
                          style={{ background: `${hop.color}20`, color: hop.color }}
                        >
                          {hop.badge}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[12px] text-[var(--text)] truncate leading-snug">
                      {hop.primary}
                    </div>
                    {hop.secondary && (
                      <div className="text-[10px] text-[var(--text4)] truncate">
                        {hop.secondary}
                      </div>
                    )}
                  </div>

                  {/* Success/fail indicator on target node */}
                  {hop.type === "target" && success !== null && (
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                      style={{ background: `${statusColor}20` }}
                    >
                      {success ? (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 5l2.5 2.5L8 3" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M3 3l4 4M7 3l-4 4" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      )}
                    </div>
                  )}
                </div>

                {/* Connector line to next node */}
                {!isLast && (
                  <div className="ml-[18px] my-1 flex items-stretch" style={{ height: "28px" }}>
                    <div className="w-px relative flex-shrink-0" style={{ background: "var(--border)" }}>
                      {/* Animated packet on this segment */}
                      {isRunning && (
                        (() => {
                          // segment idx → idx+1
                          const segStart = idx;
                          const segEnd   = idx + 1;
                          const segFrac  = Math.max(0, Math.min(1, (packetNodeF - segStart) / (segEnd - segStart)));
                          const show     = packetNodeF > segStart - 0.1 && packetNodeF < segEnd + 0.1;
                          if (!show) return null;
                          return (
                            <div
                              className="absolute w-2 h-2 rounded-full left-1/2 -translate-x-1/2"
                              style={{
                                top: `${segFrac * 100}%`,
                                backgroundColor: hops[idx].color,
                                boxShadow: `0 0 6px ${hops[idx].color}`,
                                transform: "translateX(-50%)",
                                transition: "top 0.025s linear",
                              }}
                            />
                          );
                        })()
                      )}
                    </div>
                    {/* Chevron arrow at bottom of segment */}
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
                      className="self-end ml-[-3.5px] mb-0"
                      style={{ opacity: 0.3 }}
                    >
                      <path d="M1 1l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* DNS servers footnote — show extras */}
        {netInfo && netInfo.dns_servers.length > 1 && (
          <div className="mt-3 pt-3 border-t border-[var(--border)] flex items-center gap-2">
            <span className="text-[9px] tracking-wider text-[var(--text4)] uppercase">Also</span>
            {netInfo.dns_servers.slice(1).map((s) => (
              <span key={s} className="font-mono text-[10px] text-[var(--text4)]">{s}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
