export interface HostConfig {
  id: string;
  hostname: string; // display name / shorthand
  ip: string;
  notes?: string;
  created_at: number;
}

export type PingErrorKind =
  | "timeout"
  | "no_route"
  | "dns_failed"
  | "permission_denied"
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
  auth_type: "password" | "key";
  key_path?: string;
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
  command: string;     // full command line
  base_cmd: string;    // first word
  count: number;
  first_seen: number;  // ms timestamp
  last_seen: number;
  help_summary: string | null;
}

export type SshConnectionStatus =
  | "disconnected"   // never tried
  | "checking"       // pre-flight ping in progress
  | "connecting"     // SSH handshake in progress
  | "connected"      // live session
  | "preflight_fail" // ping said host unreachable
  | "ssh_fail"       // SSH auth/connect error
  | "lost";          // connected but then dropped unexpectedly
