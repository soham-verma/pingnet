use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VpnStatus {
    pub active: bool,
    pub interfaces: Vec<String>,
    pub names: Vec<String>,
}

pub fn detect_vpn() -> VpnStatus {
    let mut interfaces: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        detect_vpn_macos(&mut interfaces, &mut names);
    }

    #[cfg(target_os = "linux")]
    {
        detect_vpn_linux(&mut interfaces, &mut names);
    }

    VpnStatus {
        active: !interfaces.is_empty() || !names.is_empty(),
        interfaces,
        names,
    }
}

#[cfg(target_os = "macos")]
fn detect_vpn_macos(interfaces: &mut Vec<String>, names: &mut Vec<String>) {
    // 1. Check for active VPN services via scutil --nc list
    if let Ok(output) = Command::new("scutil").args(["--nc", "list"]).output() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        for line in stdout.lines() {
            if line.contains("Connected") {
                if let Some(name) = extract_nc_name(line) {
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
        }
    }

    // 2. Check for VPN-like network interfaces via ifconfig
    // On macOS, utun0 is always present (system usage), but utun1+ with an
    // inet address assigned via a VPN process are reliable indicators.
    if let Ok(output) = Command::new("ifconfig").output() {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let mut current = String::new();
        let mut has_inet = false;
        let mut is_vpn_iface = false;

        for line in stdout.lines() {
            if !line.starts_with('\t') && !line.starts_with(' ') {
                // Flush previous interface
                if is_vpn_iface && has_inet && !current.is_empty() {
                    if !interfaces.contains(&current) {
                        interfaces.push(current.clone());
                    }
                }
                current = line.split(':').next().unwrap_or("").trim().to_string();
                has_inet = false;
                // utun1+ and ppp* are VPN indicators (utun0 is usually system)
                is_vpn_iface = (current.starts_with("utun")
                    && current != "utun0"
                    && current.trim_start_matches("utun").parse::<u32>().unwrap_or(0) >= 1)
                    || current.starts_with("ppp")
                    || current.starts_with("ipsec");
            } else if line.trim_start().starts_with("inet ") {
                has_inet = true;
            }
        }
        // Flush last
        if is_vpn_iface && has_inet && !current.is_empty() {
            if !interfaces.contains(&current) {
                interfaces.push(current);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn detect_vpn_linux(interfaces: &mut Vec<String>, names: &mut Vec<String>) {
    // Check for tun/ppp/tap interfaces via `ip link show`
    for iface_type in &["tun", "ppp", "tap"] {
        if let Ok(output) = Command::new("ip")
            .args(["link", "show", "type", iface_type])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            for line in stdout.lines() {
                if line.contains(':') && !line.starts_with(' ') {
                    if let Some(name) = line.split(':').nth(1) {
                        let name = name.trim().split('@').next().unwrap_or("").trim().to_string();
                        if !name.is_empty() && !interfaces.contains(&name) {
                            interfaces.push(name);
                        }
                    }
                }
            }
        }
    }

    // Also check /proc/net/dev for common VPN prefixes
    if let Ok(content) = std::fs::read_to_string("/proc/net/dev") {
        for line in content.lines().skip(2) {
            if let Some(iface) = line.split(':').next() {
                let iface = iface.trim().to_string();
                if (iface.starts_with("tun")
                    || iface.starts_with("ppp")
                    || iface.starts_with("tap")
                    || iface.starts_with("wg")  // WireGuard
                    || iface.starts_with("vpn"))
                    && !interfaces.contains(&iface)
                {
                    interfaces.push(iface);
                }
            }
        }
    }

    // Try to get service names from NetworkManager
    if let Ok(output) = Command::new("nmcli")
        .args(["-t", "-f", "NAME,TYPE,STATE", "con", "show", "--active"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        for line in stdout.lines() {
            let parts: Vec<&str> = line.splitn(3, ':').collect();
            if parts.len() == 3 {
                let vpn_types = ["vpn", "wireguard", "openvpn", "ipsec"];
                if vpn_types.iter().any(|t| parts[1].to_lowercase().contains(t)) {
                    let name = parts[0].to_string();
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
        }
    }
}

fn extract_nc_name(line: &str) -> Option<String> {
    // scutil --nc list format: "(Connected) UUID : Name [Protocol]"
    if let Some(colon_pos) = line.find(": ") {
        let after = &line[colon_pos + 2..];
        let name = after.split('[').next()?.trim().to_string();
        if !name.is_empty() {
            return Some(name);
        }
    }
    None
}
