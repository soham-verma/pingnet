//! Network info for a device: hostnames (forward + reverse DNS), a TCP connect
//! port scan run from this machine, and — over an existing SSH session — the
//! sockets actually listening on the device plus its hostname / public IP.

use serde::Serialize;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::ssh::SshState;

const MAX_SCAN_PORTS: usize = 1024;
const SCAN_CONCURRENCY: usize = 64;
const MAX_LOOKUP_TARGETS: usize = 16;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct PtrEntry {
    pub ip: String,
    /// Reverse-DNS (PTR) name, None when the address has no PTR record
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HostnameInfo {
    pub input: String,
    /// Addresses the input resolves to (just itself when it is already an IP)
    pub addresses: Vec<String>,
    pub ptr: Vec<PtrEntry>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PortProbe {
    pub port: u16,
    /// "open" | "closed" (RST) | "filtered" (no answer) | "unreachable"
    pub state: String,
    pub latency_ms: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct PortScanResult {
    pub target: String,
    pub address: String,
    pub ports: Vec<PortProbe>,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ListeningSocket {
    pub proto: String, // "tcp" | "udp"
    pub address: String,
    pub port: u16,
    pub process: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Debug, Serialize, Default)]
pub struct DeviceNetIdentity {
    pub hostname: Option<String>,
    pub fqdn: Option<String>,
    pub public_ip: Option<String>,
    pub public_ptr: Option<String>,
}

// ── DNS helpers ───────────────────────────────────────────────────────────────

/// Accept an IP (v4/v6, optionally bracketed) or a DNS name. Rejects anything
/// that could be read as a flag or smuggle other characters.
fn validate_target(s: &str) -> Result<String, String> {
    let t = s.trim().trim_start_matches('[').trim_end_matches(']');
    if t.is_empty() || t.len() > 253 || t.starts_with('-') {
        return Err(format!("Invalid host: {}", s));
    }
    if !t.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_' | '%')) {
        return Err(format!("Invalid host: {}", s));
    }
    Ok(t.to_string())
}

fn resolve(target: &str) -> Result<Vec<IpAddr>, String> {
    if let Ok(ip) = target.parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    let addrs = (target, 0u16)
        .to_socket_addrs()
        .map_err(|e| format!("DNS lookup failed: {}", e))?;
    let mut out: Vec<IpAddr> = Vec::new();
    for a in addrs {
        if !out.contains(&a.ip()) {
            out.push(a.ip());
        }
    }
    if out.is_empty() {
        return Err("Host did not resolve to any address".to_string());
    }
    Ok(out)
}

fn ptr_lookup(ip: &IpAddr) -> Option<String> {
    match dns_lookup::lookup_addr(ip) {
        // getnameinfo returns the numeric address when there is no PTR record
        Ok(name) if name.parse::<IpAddr>().is_err() && !name.is_empty() => {
            Some(name.trim_end_matches('.').to_string())
        }
        _ => None,
    }
}

fn lookup_one(input: String) -> HostnameInfo {
    let target = match validate_target(&input) {
        Ok(t) => t,
        Err(e) => return HostnameInfo { input, addresses: vec![], ptr: vec![], error: Some(e) },
    };
    match resolve(&target) {
        Ok(ips) => {
            let ips: Vec<IpAddr> = ips.into_iter().take(8).collect();
            // PTR lookups can each block for seconds on a slow resolver — run in parallel
            let ptr: Vec<PtrEntry> = std::thread::scope(|s| {
                let handles: Vec<_> = ips.iter().map(|ip| s.spawn(move || ptr_lookup(ip))).collect();
                ips.iter()
                    .zip(handles)
                    .map(|(ip, h)| PtrEntry { ip: ip.to_string(), name: h.join().ok().flatten() })
                    .collect()
            });
            HostnameInfo {
                input,
                addresses: ips.iter().map(|i| i.to_string()).collect(),
                ptr,
                error: None,
            }
        }
        Err(e) => HostnameInfo { input, addresses: vec![], ptr: vec![], error: Some(e) },
    }
}

/// Forward + reverse DNS for each target, resolved from this machine.
#[tauri::command]
pub async fn lookup_hostnames(targets: Vec<String>) -> Vec<HostnameInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let targets: Vec<String> = targets.into_iter().take(MAX_LOOKUP_TARGETS).collect();
        std::thread::scope(|s| {
            let handles: Vec<_> = targets.into_iter().map(|t| s.spawn(move || lookup_one(t))).collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        })
    })
    .await
    .unwrap_or_default()
}

// ── Port scan (TCP connect, from this machine) ───────────────────────────────

#[tauri::command]
pub async fn scan_ports(
    target: String,
    ports: Vec<u16>,
    timeout_ms: Option<u64>,
) -> Result<PortScanResult, String> {
    let target = validate_target(&target)?;
    let mut ports: Vec<u16> = ports.into_iter().filter(|p| *p != 0).collect();
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        return Err("No ports to scan".to_string());
    }
    if ports.len() > MAX_SCAN_PORTS {
        return Err(format!("Too many ports ({}); the limit is {}", ports.len(), MAX_SCAN_PORTS));
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(800).clamp(100, 5000));

    let t = target.clone();
    let ips = tauri::async_runtime::spawn_blocking(move || resolve(&t))
        .await
        .map_err(|e| e.to_string())??;
    // Prefer IPv4 — that's what the ping view uses too
    let ip = ips.iter().find(|i| i.is_ipv4()).copied().unwrap_or(ips[0]);

    let started = Instant::now();
    let sem = Arc::new(tokio::sync::Semaphore::new(SCAN_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for port in ports {
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let t0 = Instant::now();
            let res = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(SocketAddr::new(ip, port))).await;
            let state = match res {
                Ok(Ok(_stream)) => "open",
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => "closed",
                Ok(Err(_)) => "unreachable",
                Err(_) => "filtered",
            };
            let latency_ms = matches!(state, "open" | "closed").then(|| t0.elapsed().as_secs_f64() * 1000.0);
            PortProbe { port, state: state.to_string(), latency_ms }
        });
    }
    let mut out = Vec::new();
    while let Some(r) = set.join_next().await {
        if let Ok(p) = r {
            out.push(p);
        }
    }
    out.sort_by_key(|p| p.port);

    Ok(PortScanResult {
        target,
        address: ip.to_string(),
        ports: out,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

// ── Device-side info over SSH ─────────────────────────────────────────────────

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Run a POSIX sh script on the device and return stdout. stderr is discarded
/// inside the scripts so the stdout read can't deadlock on a full stderr window.
fn exec_sh(session: &ssh2::Session, script: &str) -> Result<String, String> {
    let mut ch = session.channel_session().map_err(|e| format!("channel: {}", e))?;
    ch.exec(&format!("sh -c {}", shell_quote(script))).map_err(|e| format!("exec: {}", e))?;
    let mut out = String::new();
    ch.read_to_string(&mut out).map_err(|e| e.to_string())?;
    let _ = ch.wait_close();
    Ok(out)
}

const LISTEN_SCRIPT: &str = r##"
if command -v ss >/dev/null 2>&1; then
  echo '#SS'; ss -H -tulnp 2>/dev/null || ss -tulnp 2>/dev/null | tail -n +2
elif [ "$(uname -s)" = Darwin ]; then
  echo '#LSOF'; lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | tail -n +2; lsof -nP -iUDP 2>/dev/null | tail -n +2
elif command -v netstat >/dev/null 2>&1; then
  echo '#NETSTAT'; netstat -tulnp 2>/dev/null || netstat -tuln 2>/dev/null
fi
"##;

const IDENTITY_SCRIPT: &str = r##"
echo "#HN $(hostname 2>/dev/null)"
echo "#FQDN $(hostname -f 2>/dev/null)"
PUB=$( (curl -fsS -m 5 https://api.ipify.org || wget -qO- -T 5 https://api.ipify.org) 2>/dev/null | head -c 64)
echo "#PUB $PUB"
"##;

/// Split "addr:port" / "[v6]:port" / "*:port" / "127.0.0.53%lo:53".
fn split_addr_port(s: &str) -> Option<(String, u16)> {
    let idx = s.rfind(':')?;
    let port: u16 = s[idx + 1..].parse().ok()?;
    let mut addr = s[..idx].trim_start_matches('[').trim_end_matches(']').to_string();
    if let Some(p) = addr.find('%') {
        addr.truncate(p);
    }
    if addr.is_empty() {
        addr = "*".to_string();
    }
    Some((addr, port))
}

/// ss: `tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))`
fn parse_ss_line(line: &str) -> Option<ListeningSocket> {
    let f: Vec<&str> = line.split_whitespace().collect();
    if f.len() < 5 {
        return None;
    }
    let proto = f[0].to_lowercase();
    let keep = (proto.starts_with("tcp") && f[1] == "LISTEN") || proto.starts_with("udp");
    if !keep {
        return None;
    }
    let (address, port) = split_addr_port(f[4])?;
    let (process, pid) = match line.find("users:((\"") {
        Some(i) => {
            let rest = &line[i + 9..];
            let name = rest.split('"').next().map(|s| s.to_string());
            let pid = rest
                .find("pid=")
                .and_then(|j| rest[j + 4..].split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|n| n.parse().ok());
            (name, pid)
        }
        None => (None, None),
    };
    Some(ListeningSocket {
        proto: if proto.starts_with("tcp") { "tcp".into() } else { "udp".into() },
        address, port, process, pid,
    })
}

/// netstat -tulnp: `tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 812/sshd` (udp has no state)
fn parse_netstat_line(line: &str) -> Option<ListeningSocket> {
    let f: Vec<&str> = line.split_whitespace().collect();
    if f.len() < 4 {
        return None;
    }
    let proto = f[0].to_lowercase();
    let prog = if proto.starts_with("tcp") {
        if f.get(5) != Some(&"LISTEN") {
            return None;
        }
        f.get(6)
    } else if proto.starts_with("udp") {
        f.get(5)
    } else {
        return None;
    };
    let (address, port) = split_addr_port(f[3])?;
    let (pid, process) = match prog.and_then(|p| p.split_once('/')) {
        Some((pid, name)) => (pid.parse().ok(), Some(name.to_string())),
        None => (None, None),
    };
    Some(ListeningSocket {
        proto: if proto.starts_with("tcp") { "tcp".into() } else { "udp".into() },
        address, port, process, pid,
    })
}

/// lsof -nP: `sshd 812 root 3u IPv4 0x… 0t0 TCP *:22 (LISTEN)`
fn parse_lsof_line(line: &str) -> Option<ListeningSocket> {
    let f: Vec<&str> = line.split_whitespace().collect();
    if f.len() < 9 {
        return None;
    }
    let proto = f[7].to_lowercase();
    if proto != "tcp" && proto != "udp" {
        return None;
    }
    if f[8].contains("->") {
        return None; // connected socket, not a listener
    }
    let (address, port) = split_addr_port(f[8])?;
    Some(ListeningSocket {
        proto,
        address,
        port,
        process: Some(f[0].replace("\\x20", " ")),
        pid: f[1].parse().ok(),
    })
}

fn parse_listening(out: &str) -> Result<Vec<ListeningSocket>, String> {
    let mut lines = out.lines().map(str::trim).filter(|l| !l.is_empty());
    let parser: fn(&str) -> Option<ListeningSocket> = match lines.next() {
        Some("#SS") => parse_ss_line,
        Some("#LSOF") => parse_lsof_line,
        Some("#NETSTAT") => parse_netstat_line,
        _ => {
            return Err("Couldn't list listening ports — the device needs ss, netstat (Linux) or lsof (macOS)".to_string())
        }
    };
    let mut socks: Vec<ListeningSocket> = Vec::new();
    for s in lines.filter_map(parser) {
        if !socks.contains(&s) {
            socks.push(s);
        }
    }
    socks.sort_by(|a, b| a.proto.cmp(&b.proto).then(a.port.cmp(&b.port)).then(a.address.cmp(&b.address)));
    Ok(socks)
}

fn parse_identity(out: &str) -> DeviceNetIdentity {
    let mut id = DeviceNetIdentity::default();
    let non_empty = |s: &str| {
        let s = s.trim();
        (!s.is_empty()).then(|| s.to_string())
    };
    for line in out.lines() {
        if let Some(v) = line.strip_prefix("#HN ") {
            id.hostname = non_empty(v);
        } else if let Some(v) = line.strip_prefix("#FQDN ") {
            id.fqdn = non_empty(v);
        } else if let Some(v) = line.strip_prefix("#PUB ") {
            id.public_ip = non_empty(v).filter(|s| s.parse::<IpAddr>().is_ok());
        }
    }
    id
}

/// Sockets listening on the device (TCP LISTEN + bound UDP), via the SSH session.
#[tauri::command]
pub async fn ssh_listening_ports(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<Vec<ListeningSocket>, String> {
    let conn = crate::ssh::get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
        let out = exec_sh(&session, LISTEN_SCRIPT)?;
        parse_listening(&out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The device's own hostname / FQDN and its public (egress) IP, as seen from
/// the device — plus the PTR record of that public IP, resolved locally.
#[tauri::command]
pub async fn ssh_device_identity(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<DeviceNetIdentity, String> {
    let conn = crate::ssh::get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = {
            let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
            exec_sh(&session, IDENTITY_SCRIPT)?
        }; // release the session lock before the (possibly slow) PTR lookup
        let mut id = parse_identity(&out);
        if let Some(ip) = id.public_ip.as_deref().and_then(|s| s.parse::<IpAddr>().ok()) {
            id.public_ptr = ptr_lookup(&ip);
        }
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_addr_port_variants() {
        assert_eq!(split_addr_port("0.0.0.0:22"), Some(("0.0.0.0".into(), 22)));
        assert_eq!(split_addr_port("[::]:443"), Some(("::".into(), 443)));
        assert_eq!(split_addr_port("*:5353"), Some(("*".into(), 5353)));
        assert_eq!(split_addr_port("127.0.0.53%lo:53"), Some(("127.0.0.53".into(), 53)));
        assert_eq!(split_addr_port("[fe80::1%eth0]:546"), Some(("fe80::1".into(), 546)));
        assert_eq!(split_addr_port("nope"), None);
    }

    #[test]
    fn parses_ss_output() {
        let out = "#SS\n\
tcp   LISTEN 0      4096       0.0.0.0:22        0.0.0.0:*    users:((\"sshd\",pid=812,fd=3))\n\
tcp   ESTAB  0      0      10.0.0.5:22        10.0.0.9:51234\n\
udp   UNCONN 0      0      127.0.0.53%lo:53        0.0.0.0:*    users:((\"systemd-resolve\",pid=585,fd=13))\n\
tcp   LISTEN 0      511           [::]:80           [::]:*\n";
        let s = parse_listening(out).unwrap();
        assert_eq!(s.len(), 3);
        assert_eq!(s[0], ListeningSocket { proto: "tcp".into(), address: "0.0.0.0".into(), port: 22, process: Some("sshd".into()), pid: Some(812) });
        assert_eq!(s[1].port, 80);
        assert_eq!(s[1].process, None);
        assert_eq!(s[2].proto, "udp");
        assert_eq!(s[2].address, "127.0.0.53");
    }

    #[test]
    fn parses_netstat_output() {
        let out = "#NETSTAT\nActive Internet connections (only servers)\n\
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name\n\
tcp        0      0 0.0.0.0:5760            0.0.0.0:*               LISTEN      901/mavproxy\n\
udp        0      0 0.0.0.0:14550           0.0.0.0:*                           901/mavproxy\n\
tcp        0      0 10.0.0.5:22             10.0.0.9:5000           ESTABLISHED -\n";
        let s = parse_listening(out).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].port, 5760);
        assert_eq!(s[0].process.as_deref(), Some("mavproxy"));
        assert_eq!(s[1].proto, "udp");
        assert_eq!(s[1].port, 14550);
    }

    #[test]
    fn parses_lsof_output_and_dedupes() {
        let out = "#LSOF\n\
rapportd  540 soham    8u  IPv4 0xabc      0t0  TCP *:49152 (LISTEN)\n\
rapportd  540 soham    8u  IPv4 0xabc      0t0  TCP *:49152 (LISTEN)\n\
mDNSRespo 400 _mdns    9u  IPv4 0xdef      0t0  UDP *:5353\n\
Chrome    900 soham   30u  IPv4 0x123      0t0  UDP 10.0.0.2:5000->10.0.0.3:6000\n";
        let s = parse_listening(out).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].proto, "tcp");
        assert_eq!(s[0].pid, Some(540));
        assert_eq!(s[1].port, 5353);
    }

    #[test]
    fn unknown_output_is_error() {
        assert!(parse_listening("'command' is not recognized").is_err());
    }

    #[test]
    fn parses_identity() {
        let id = parse_identity("#HN drone-01\n#FQDN drone-01.fleet.example\n#PUB 203.0.113.7\n");
        assert_eq!(id.hostname.as_deref(), Some("drone-01"));
        assert_eq!(id.fqdn.as_deref(), Some("drone-01.fleet.example"));
        assert_eq!(id.public_ip.as_deref(), Some("203.0.113.7"));
        let none = parse_identity("#HN x\n#FQDN \n#PUB <html>\n");
        assert_eq!(none.fqdn, None);
        assert_eq!(none.public_ip, None);
    }

    #[test]
    fn validate_target_rules() {
        assert!(validate_target("10.0.0.1").is_ok());
        assert_eq!(validate_target("[::1]").unwrap(), "::1");
        assert!(validate_target("drone-01.local").is_ok());
        assert!(validate_target("-oProxyCommand").is_err());
        assert!(validate_target("a b").is_err());
        assert!(validate_target("x;rm").is_err());
    }
}
