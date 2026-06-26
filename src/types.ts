/** A labelled IP address associated with a host */
export interface HostIp {
  address: string;
  /** Type/role of this IP — used for display only, does not affect ping behavior */
  type: "local" | "wifi" | "vpn" | "public" | "tailscale" | "other";
}

export interface HostConfig {
  id: string;
  hostname: string;
  /** The active IP used for pinging */
  ip: string;
  /** Type/role label for the active IP */
  ip_type?: HostIp["type"];
  /** Additional IPs — stored for reference; not pinged automatically */
  extra_ips?: HostIp[];
  notes?: string;
  created_at: number;
  // Alert settings
  alert_on_down: boolean;
  alert_on_recovery: boolean;
  alert_latency_ms: number | null;
  // Persisted SSH config — passwords are never stored here
  ssh_port?: number;
  ssh_username?: string;
  ssh_auth_type?: string;
  ssh_key_path?: string;
  ssh_key_name?: string;
}

export type PingErrorKind =
  | "timeout"
  | "no_route"
  | "dns_failed"
  | "permission_denied"
  | "invalid_host"
  | "unknown";

export interface PingResult {
  success: boolean;
  latency_ms: number | null;
  error_kind: PingErrorKind | null;
  error_detail: string | null;
  is_private_ip: boolean;
}

export interface VpnStatus {
  active: boolean;
  interfaces: string[];
  names: string[];
}

export type PingStatus = "idle" | "pinging" | "ok" | "fail";

export interface HostState extends HostConfig {
  ping_status: PingStatus;
  last_result: PingResult | null;
  last_pinged_at: number | null;
  vpn_at_time_of_failure: VpnStatus | null;
}

// ── SSH types ──────────────────────────────────────────────────────────────────

export interface SshConfig {
  port: number;
  username: string;
  auth_type: "password" | "key" | "keychain" | "agent" | "totp";
  key_path?: string;
  key_name?: string;  // for keychain keys
}

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  is_symlink: boolean;
  permissions: string;
  modified: number;
}

export interface TransferItem {
  id: string;
  name: string;
  kind: "upload" | "download";
  bytes_done: number;
  total_bytes: number;
  status: "running" | "done" | "error";
  error?: string;
}

export interface CommandEntry {
  command: string;
  base_cmd: string;
  count: number;
  first_seen: number;
  last_seen: number;
  help_summary: string | null;
}

export type SshConnectionStatus =
  | "disconnected"
  | "checking"
  | "connecting"
  | "connected"
  | "preflight_fail"
  | "ssh_fail"
  | "lost";

// ── Metrics ────────────────────────────────────────────────────────────────────

export interface CoreStat {
  index: number;
  percent: number;
}

export interface NetIface {
  name: string;
  rx_kbps: number;
  tx_kbps: number;
}

export interface DiskIo {
  name: string;
  read_kbps: number;
  write_kbps: number;
}

export interface ThermalZone {
  name: string;
  temp_c: number;
}

export interface GpuStat {
  vendor: "nvidia" | "jetson" | "rpi" | "amd";
  name: string;
  util_pct: number | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  temp_c: number | null;
  power_w: number | null;
  note: string | null;
}

export interface ProcessEntry {
  pid: number;
  user: string;
  cpu_pct: number;
  mem_pct: number;
  command: string;
}

export interface MetricsSnapshot {
  // Summary
  cpu_percent: number | null;
  cpu_unavailable_reason: string | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  mem_unavailable_reason: string | null;
  disk_used_pct: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  disk_unavailable_reason: string | null;
  load_avg_1: number | null;
  load_avg_5: number | null;
  load_avg_15: number | null;
  uptime_seconds: number | null;
  // Advanced
  cores: CoreStat[];
  net_ifaces: NetIface[];
  disk_io: DiskIo[];
  thermal: ThermalZone[];
  gpus: GpuStat[];
  processes: ProcessEntry[];
  // Platform
  arch: string;
  kernel: string;
  model: string;
  os_type: string;   // "linux" | "macos" | "windows" | "unknown"
  is_first_poll: boolean;
}

export interface Capabilities {
  arch: string;
  kernel: string;
  model: string;
  is_jetson: boolean;
  is_rpi: boolean;
  proc_stat: boolean;
  proc_meminfo: boolean;
  proc_net_dev: boolean;
  proc_diskstats: boolean;
  proc_loadavg: boolean;
  proc_uptime: boolean;
  free_format: "modern" | "busybox" | "none";
  has_top: boolean;
  has_ps: boolean;
  has_df: boolean;
  has_nvidia_smi: boolean;
  has_tegrastats: boolean;
  has_jetson_gpu_load: boolean;
  has_vcgencmd: boolean;
  has_rocm_smi: boolean;
  has_sensors: boolean;
  has_netstat: boolean;
  thermal_zone_count: number;
}

// ── SSH Key Manager ────────────────────────────────────────────────────────────

export interface RouteEntry {
  destination: string;
  gateway:     string;
  iface:       string;
  metric:      number | null;
  flags:       string;
}

export interface IfaceDetails {
  name: string;
  mac: string | null;
  mtu: number | null;
  operstate: string | null;
  speed_mbps: number | null;   // -1 = N/A (virtual/CAN/etc.)
  ipv4: string[];
  ipv6: string[];
  rx_bytes: number;
  tx_bytes: number;
  rx_packets: number;
  tx_packets: number;
  rx_errors: number;
  tx_errors: number;
  rx_dropped: number;
  tx_dropped: number;
  driver: string | null;
  bus_info: string | null;
}

export interface SpeedtestResult {
  download_mbps: number;
  upload_mbps: number;
  latency_ms: number;
  jitter_ms: number;
  server: string;
  error: string | null;
}

export interface MetricsLogEntry {
  ts: number;          // Date.now()
  snapshot: import("./types").MetricsSnapshot;
}

export interface KeyInfo {
  name: string;
  public_key: string;
  comment: string;
  created_at: number;
}

export interface AuditEntry {
  ts: number;         // Unix ms
  host: string;
  username: string;
  command: string;
}

// ── Docker ────────────────────────────────────────────────────────────────────

export interface DockerContainer {
  id: string;
  names: string;
  image: string;
  /** Raw docker state: "running" | "exited" | "paused" | "created" | "restarting" | "dead" | "removing" */
  state: string;
  /** Human-readable, e.g. "Up 2 hours", "Exited (0) 3 minutes ago" */
  status: string;
  ports: string;
  created_at: string;
}

export interface DockerService {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface DockerComposeProject {
  name: string;
  status: string;
  config_files: string;
  services: DockerService[];
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created_at: string;
}
