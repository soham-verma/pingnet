// Pure helpers for the Network Info panel (port scan + listening sockets).
// No React/Tauri imports so they can be unit-tested directly.

export type ProbeState = "open" | "closed" | "filtered" | "unreachable";

export interface PortProbe {
  port: number;
  state: ProbeState;
  latency_ms: number | null;
}

export interface PortScanResult {
  target: string;
  address: string;
  ports: PortProbe[];
  duration_ms: number;
}

export interface ListeningSocket {
  proto: "tcp" | "udp";
  address: string;
  port: number;
  process: string | null;
  pid: number | null;
}

export type PortVerdict =
  | "active"        // reachable from here AND confirmed listening on the device
  | "open"          // reachable from here (no device-side data)
  | "listening"     // listening on the device, not scanned from here
  | "local-only"    // listening only on loopback
  | "blocked"       // listening on the device but not reachable from here (firewall/NAT)
  | "closed"        // not active: host answered with RST
  | "filtered"      // no answer — dropped by a firewall, or host down
  | "unreachable"
  | "udp";          // UDP socket bound on the device (not scannable via TCP connect)

export interface PortRow {
  proto: "tcp" | "udp";
  port: number;
  service: string | null;
  remote: ProbeState | null;           // null = not scanned
  latency_ms: number | null;
  listening: ListeningSocket[] | null; // null = no device-side data (no SSH)
  verdict: PortVerdict;
}

/** Well-known ports worth checking by default (TCP). */
export const COMMON_PORTS: Record<number, string> = {
  20: "ftp-data", 21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns",
  80: "http", 110: "pop3", 111: "rpcbind", 135: "msrpc", 139: "netbios", 143: "imap",
  443: "https", 445: "smb", 465: "smtps", 502: "modbus", 554: "rtsp", 587: "submission",
  631: "ipp", 873: "rsync", 993: "imaps", 995: "pop3s", 1080: "socks", 1433: "mssql",
  1521: "oracle", 1883: "mqtt", 2049: "nfs", 2375: "docker", 2376: "docker-tls",
  3000: "grafana/dev", 3306: "mysql", 3389: "rdp", 4840: "opc-ua", 5000: "http-dev",
  5060: "sip", 5432: "postgres", 5555: "adb", 5672: "amqp", 5760: "mavlink",
  5900: "vnc", 6379: "redis", 6443: "kube-api", 8000: "http-alt", 8080: "http-proxy",
  8086: "influxdb", 8443: "https-alt", 8554: "rtsp-alt", 8883: "mqtt-tls", 9000: "http-alt",
  9090: "prometheus", 9100: "node-exporter", 9200: "elasticsearch", 10250: "kubelet",
  11211: "memcached", 27017: "mongodb",
};

// Extra UDP names so device-side UDP sockets get labels too
const UDP_SERVICES: Record<number, string> = {
  53: "dns", 67: "dhcp", 68: "dhcp", 123: "ntp", 137: "netbios-ns", 161: "snmp",
  500: "ike", 1900: "ssdp", 4500: "ipsec-nat", 5353: "mdns", 14550: "mavlink", 14555: "mavlink",
  51820: "wireguard",
};

export const DEFAULT_SCAN_PORTS: number[] = Object.keys(COMMON_PORTS).map(Number);

export const MAX_SCAN_PORTS = 1024;

export function serviceName(port: number, proto: "tcp" | "udp" = "tcp"): string | null {
  if (proto === "udp") return UDP_SERVICES[port] ?? COMMON_PORTS[port] ?? null;
  return COMMON_PORTS[port] ?? null;
}

/**
 * Parse a port spec like "22, 80 443 8000-8010". Returns sorted unique ports,
 * or an error message for the first bad token / an oversized spec.
 */
export function parsePortSpec(spec: string): { ports: number[]; error: string | null } {
  const set = new Set<number>();
  const tokens = spec.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return { ports: [], error: "Enter at least one port" };
  for (const tok of tokens) {
    const m = tok.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!m) return { ports: [], error: `Invalid port "${tok}"` };
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b) return { ports: [], error: `Invalid range "${tok}"` };
    if (b - a + 1 + set.size > MAX_SCAN_PORTS) {
      return { ports: [], error: `Too many ports — the limit is ${MAX_SCAN_PORTS}` };
    }
    for (let p = a; p <= b; p++) set.add(p);
  }
  return { ports: [...set].sort((x, y) => x - y), error: null };
}

export function isLoopback(addr: string): boolean {
  const a = addr.toLowerCase();
  return a.startsWith("127.") || a === "::1" || a === "localhost" || a === "::ffff:127.0.0.1";
}

function verdictFor(remote: ProbeState | null, listening: ListeningSocket[] | null): PortVerdict {
  const isListening = listening !== null && listening.length > 0;
  if (remote === "open") return isListening ? "active" : "open";
  if (isListening) {
    if (listening!.every((s) => isLoopback(s.address))) return "local-only";
    return remote === null ? "listening" : "blocked";
  }
  if (remote === "closed") return "closed";
  if (remote === "filtered") return "filtered";
  if (remote === "unreachable") return "unreachable";
  return "closed";
}

/**
 * Merge a TCP scan (from this machine) with the device's listening sockets
 * (over SSH) into one row per proto+port. Either input may be null.
 */
export function mergePortRows(scan: PortProbe[] | null, listening: ListeningSocket[] | null): PortRow[] {
  const rows = new Map<string, PortRow>();
  const tcpListen = new Map<number, ListeningSocket[]>();
  const udpListen = new Map<number, ListeningSocket[]>();
  for (const s of listening ?? []) {
    const m = s.proto === "udp" ? udpListen : tcpListen;
    m.set(s.port, [...(m.get(s.port) ?? []), s]);
  }

  for (const p of scan ?? []) {
    const l = listening === null ? null : tcpListen.get(p.port) ?? [];
    rows.set(`tcp:${p.port}`, {
      proto: "tcp", port: p.port, service: serviceName(p.port),
      remote: p.state, latency_ms: p.latency_ms, listening: l, verdict: verdictFor(p.state, l),
    });
  }
  for (const [port, socks] of tcpListen) {
    if (rows.has(`tcp:${port}`)) continue;
    rows.set(`tcp:${port}`, {
      proto: "tcp", port, service: serviceName(port),
      remote: null, latency_ms: null, listening: socks, verdict: verdictFor(null, socks),
    });
  }
  for (const [port, socks] of udpListen) {
    const local = socks.every((s) => isLoopback(s.address));
    rows.set(`udp:${port}`, {
      proto: "udp", port, service: serviceName(port, "udp"),
      remote: null, latency_ms: null, listening: socks, verdict: local ? "local-only" : "udp",
    });
  }

  return [...rows.values()].sort((a, b) =>
    a.proto === b.proto ? a.port - b.port : a.proto === "tcp" ? -1 : 1);
}

/** Rows hidden by default: nothing is running there. */
export function isQuietRow(r: PortRow): boolean {
  return r.verdict === "closed" || r.verdict === "filtered" || r.verdict === "unreachable";
}
