use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PingResult {
    pub success: bool,
    pub latency_ms: Option<f64>,
    pub error_kind: Option<String>,
    pub error_detail: Option<String>,
    pub is_private_ip: bool,
}

pub fn is_private_ip(ip: &str) -> bool {
    let parts: Vec<u8> = ip
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();
    if parts.len() != 4 {
        return false;
    }
    let (a, b) = (parts[0], parts[1]);
    a == 10
        || (a == 172 && b >= 16 && b <= 31)
        || (a == 192 && b == 168)
        || (a == 127)
}

pub fn ping(ip: &str) -> PingResult {
    let private = is_private_ip(ip);

    // Build platform-specific ping command
    // macOS: -W is in milliseconds, Linux: -W is in seconds
    // Windows: -n (count) and -w (timeout ms), no -c flag
    #[cfg(target_os = "macos")]
    let output = Command::new("ping")
        .args(["-c", "1", "-W", "3000", ip])
        .output();

    #[cfg(target_os = "linux")]
    let output = Command::new("ping")
        .args(["-c", "1", "-W", "3", ip])
        .output();

    #[cfg(target_os = "windows")]
    let output = Command::new("ping")
        .args(["-n", "1", "-w", "3000", ip])
        .output();

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let output = Command::new("ping")
        .args(["-c", "1", ip])
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();

            if out.status.success() {
                let latency = parse_latency(&stdout);
                PingResult {
                    success: true,
                    latency_ms: latency,
                    error_kind: None,
                    error_detail: None,
                    is_private_ip: private,
                }
            } else {
                let (kind, detail) = parse_error(&stdout, &stderr, ip, private);
                PingResult {
                    success: false,
                    latency_ms: None,
                    error_kind: Some(kind),
                    error_detail: Some(detail),
                    is_private_ip: private,
                }
            }
        }
        Err(e) => PingResult {
            success: false,
            latency_ms: None,
            error_kind: Some("system_error".to_string()),
            error_detail: Some(format!("Could not run ping: {}", e)),
            is_private_ip: private,
        },
    }
}

fn parse_latency(output: &str) -> Option<f64> {
    // Handles:
    //   Unix:    "time=12.4 ms", "time=12.4ms"
    //   Windows: "time=14ms", "time<1ms" (no space)
    for line in output.lines() {
        if let Some(pos) = line.find("time=") {
            let after = &line[pos + 5..];
            let end = after
                .find(|c: char| c == ' ' || c == 'm' || c == '\n')
                .unwrap_or(after.len());
            if let Ok(ms) = after[..end].parse::<f64>() {
                return Some(ms);
            }
        }
        // "time < 1 ms" (Unix) or "time<1ms" (Windows)
        if line.contains("time <") || line.contains("time<") {
            return Some(0.5);
        }
    }
    None
}

fn parse_error(stdout: &str, stderr: &str, _ip: &str, private: bool) -> (String, String) {
    let combined = format!("{} {}", stdout, stderr).to_lowercase();

    // Unreachable — Unix + Windows variants
    if combined.contains("network is unreachable")
        || combined.contains("no route to host")
        || combined.contains("destination host unreachable")
        || combined.contains("destination net unreachable")
    {
        let detail = if private {
            "No route to this private address — check VPN connection or local network".to_string()
        } else {
            "No route to host — the network path to this address doesn't exist".to_string()
        };
        return ("no_route".to_string(), detail);
    }

    // Timeout — Unix + Windows variants
    if combined.contains("100% packet loss")
        || combined.contains("request timeout")
        || combined.contains("request timed out")
        || combined.contains("time out")
        || combined.contains("0 received")
    {
        let detail = if private {
            "Host timed out — if this is a private IP, your VPN may not be routing to this subnet".to_string()
        } else {
            "Host did not respond within timeout — it may be offline, behind a firewall, or blocking ICMP".to_string()
        };
        return ("timeout".to_string(), detail);
    }

    // DNS failure — Unix + Windows variants
    if combined.contains("name or service not known")
        || combined.contains("cannot resolve")
        || combined.contains("nodename nor servname provided")
        || combined.contains("could not resolve")
        || combined.contains("ping request could not find host")
    {
        return ("dns_failed".to_string(), "DNS resolution failed — the hostname couldn't be resolved. Check your DNS settings.".to_string());
    }

    // Permission — Unix + Windows variants
    if combined.contains("permission denied")
        || combined.contains("operation not permitted")
        || combined.contains("general failure")
        || combined.contains("transmit failed")
    {
        return ("permission_denied".to_string(), "Permission denied — ping may require elevated privileges on this system".to_string());
    }

    {
        let raw = stdout.trim();
        let msg = if raw.is_empty() { stderr.trim() } else { raw };
        ("unknown".to_string(), format!("Ping failed: {}", &msg[..msg.len().min(200)]))
    }
}
