mod audit;
mod command_history;
mod docker;
mod http_client;
mod keys;
mod local_pty;
mod metrics;
mod ping;
mod ssh;
mod storage;
mod vpn;

use ping::PingResult;
use ssh::SshState;
use storage::HostConfig;
use vpn::VpnStatus;

/// Open a URL or custom-scheme URI using the OS default handler.
/// Only explicitly allowed schemes may be passed — file://, javascript:, data:,
/// and every other unlisted scheme are rejected so a compromised webview cannot
/// launch arbitrary local executables or access local files.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Schemes the Pingnet UI legitimately opens.  Extend this list deliberately
    // rather than accepting all unknown schemes.
    const ALLOWED: &[&str] = &[
        "https://",
        "mailto:",
        "vscode://",
        "vscode-insiders://",
        "cursor://",
        "windsurf://",
        "jetbrains://",
        "jetbrains-gateway://",
    ];

    let lower = url.to_lowercase();
    if !ALLOWED.iter().any(|scheme| lower.starts_with(scheme)) {
        return Err(format!(
            "Scheme not permitted. Allowed: https, mailto, vscode, cursor, windsurf, jetbrains. Got: {}",
            url.split(':').next().unwrap_or(&url)
        ));
    }

    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn ping_host(ip: String) -> PingResult {
    // spawn_blocking so the synchronous `ping` binary call does not stall
    // the async Tauri executor (blocking the IPC handler thread for up to 3 s).
    tauri::async_runtime::spawn_blocking(move || ping::ping(&ip))
        .await
        .unwrap_or_else(|_| PingResult {
            success: false,
            latency_ms: None,
            error_kind: Some("unknown".to_string()),
            error_detail: Some("internal task error".to_string()),
            is_private_ip: false,
        })
}

#[tauri::command]
async fn detect_vpn() -> VpnStatus {
    tauri::async_runtime::spawn_blocking(vpn::detect_vpn)
        .await
        .unwrap_or_else(|_| VpnStatus { active: false, interfaces: vec![], names: vec![] })
}

#[tauri::command]
fn load_hosts(app: tauri::AppHandle) -> Result<Vec<HostConfig>, String> {
    storage::load_hosts(&app)
}

#[tauri::command]
fn save_hosts(app: tauri::AppHandle, hosts: Vec<HostConfig>) -> Result<(), String> {
    storage::save_hosts(&app, &hosts)
}

/// Write arbitrary text content to a caller-specified absolute path.
/// Used by the metrics export — the frontend opens a save dialog via
/// tauri-plugin-dialog, gets back a path, then calls this to write the JSON.
/// Only the dialog-issued path is accepted; the frontend never constructs paths.
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::path::PathBuf;

    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("Write path must be absolute".to_string());
    }

    let parent = p
        .parent()
        .ok_or_else(|| "Write path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    // Refuse writes outside the user's home directory. Canonicalise the parent
    // after creating it so symlinked directories cannot redirect the write.
    let home = dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())?;
    let home = home.canonicalize().map_err(|e| e.to_string())?;
    let parent = parent.canonicalize().map_err(|e| e.to_string())?;
    if !parent.starts_with(&home) {
        return Err("Write path must be inside your home directory".to_string());
    }

    // Block writes to sensitive files that could enable code execution or
    // credential theft even when the path is inside the home directory.
    // The comparison is done on the *canonicalized* parent so path traversal
    // tricks (e.g. foo/../.ssh) cannot bypass the check.
    let sensitive_dirs: &[&str] = &[".ssh", ".aws", ".gnupg", ".config/gcloud"];
    let sensitive_files: &[&str] = &[
        ".zshrc", ".zprofile", ".zshenv", ".zlogin",
        ".bashrc", ".bash_profile", ".bash_login", ".profile",
        ".kshrc", ".tcshrc", ".fishrc",
        ".npmrc", ".pypirc", ".netrc", ".gitconfig",
        ".gitcredentials", ".curlrc",
    ];

    let canon_path = p.canonicalize().unwrap_or_else(|_| p.clone());
    let path_str = canon_path.to_string_lossy();

    for dir in sensitive_dirs {
        let blocked = home.join(dir);
        if canon_path.starts_with(&blocked) || parent.starts_with(&blocked) {
            return Err(format!("Write to sensitive directory '{}' is not allowed", dir));
        }
    }
    for file in sensitive_files {
        let blocked = home.join(file);
        if canon_path == blocked || p == blocked {
            return Err(format!("Write to sensitive file '{}' is not allowed", file));
        }
    }
    // Belt-and-suspenders: also reject anything whose lowercased path contains
    // "authorized_keys" (common SSH persistence target).
    if path_str.to_lowercase().contains("authorized_keys") {
        return Err("Write to authorized_keys is not allowed".to_string());
    }

    if let Ok(meta) = std::fs::symlink_metadata(&p) {
        if meta.file_type().is_symlink() {
            return Err("Refusing to write through a symlink".to_string());
        }
        if meta.is_dir() {
            return Err("Write path points to a directory".to_string());
        }
    }

    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&p)
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

/// Local network info used to render the multi-hop Network Route visualiser.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct LocalNetworkInfo {
    local_ip:    Option<String>,
    iface_name:  Option<String>,
    gateway:     Option<String>,
    dns_servers: Vec<String>,
    /// Best-guess: true when the local IP is in a private/RFC-1918 range (implies DHCP on home/office nets)
    dhcp:        bool,
}

#[tauri::command]
fn get_local_network_info() -> LocalNetworkInfo {
    let mut info = LocalNetworkInfo {
        local_ip: None, iface_name: None, gateway: None,
        dns_servers: vec![], dhcp: false,
    };

    #[cfg(target_os = "macos")]
    {
        // Default gateway + interface
        if let Ok(out) = std::process::Command::new("route").args(["get","default"]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let line = line.trim();
                if let Some(v) = line.strip_prefix("gateway: ") { info.gateway  = Some(v.trim().to_string()); }
                if let Some(v) = line.strip_prefix("interface: ") { info.iface_name = Some(v.trim().to_string()); }
            }
        }
        // Local IP for that interface
        if let Some(ref iface) = info.iface_name.clone() {
            if let Ok(out) = std::process::Command::new("ipconfig").args(["getifaddr", iface]).output() {
                let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !ip.is_empty() { info.local_ip = Some(ip); }
            }
        }
        // DNS servers
        if let Ok(out) = std::process::Command::new("scutil").args(["--dns"]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("nameserver[") {
                    if let Some(pos) = rest.find("] : ") {
                        let server = rest[pos+4..].trim().to_string();
                        if !info.dns_servers.contains(&server) { info.dns_servers.push(server); }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Default route: "default via <gw> dev <iface> ... src <ip>"
        if let Ok(out) = std::process::Command::new("ip").args(["route","show","default"]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if !line.starts_with("default via ") { continue; }
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 { info.gateway = Some(parts[2].to_string()); }
                if let Some(i) = parts.iter().position(|&p| p == "dev") {
                    if i+1 < parts.len() { info.iface_name = Some(parts[i+1].to_string()); }
                }
                if let Some(i) = parts.iter().position(|&p| p == "src") {
                    if i+1 < parts.len() { info.local_ip = Some(parts[i+1].to_string()); }
                }
                break;
            }
        }
        // Local IP from interface if "src" wasn't in the route line
        if info.local_ip.is_none() {
            if let Some(ref iface) = info.iface_name.clone() {
                if let Ok(out) = std::process::Command::new("ip").args(["addr","show", iface.as_str()]).output() {
                    let text = String::from_utf8_lossy(&out.stdout);
                    for line in text.lines() {
                        let line = line.trim();
                        if line.starts_with("inet ") && !line.starts_with("inet6") {
                            let parts: Vec<&str> = line.split_whitespace().collect();
                            if parts.len() >= 2 {
                                info.local_ip = Some(parts[1].split('/').next().unwrap_or("").to_string());
                            }
                            break;
                        }
                    }
                }
            }
        }
        // DNS from /etc/resolv.conf
        if let Ok(content) = std::fs::read_to_string("/etc/resolv.conf") {
            for line in content.lines() {
                if let Some(ns) = line.trim().strip_prefix("nameserver ") {
                    let s = ns.trim().to_string();
                    if !info.dns_servers.contains(&s) { info.dns_servers.push(s); }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        #[cfg(target_os = "windows")]
        use std::os::windows::process::CommandExt;
        let make_cmd = |prog: &str, args: &[&str]| {
            let mut c = std::process::Command::new(prog);
            c.args(args);
            #[cfg(target_os = "windows")]
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
            c
        };
        if let Ok(out) = make_cmd("ipconfig", &["/all"]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut capture = false;
            for line in text.lines() {
                let lower = line.to_lowercase();
                // Start capture on the first adapter section that has an IP
                if lower.contains("ethernet adapter") || lower.contains("wireless lan adapter") || lower.contains("wi-fi") {
                    capture = true;
                }
                if !capture { continue; }
                if lower.contains("ipv4 address") && info.local_ip.is_none() {
                    if let Some(pos) = line.rfind(':') {
                        let ip = line[pos+1..].trim().trim_end_matches("(Preferred)").trim().to_string();
                        if !ip.is_empty() { info.local_ip = Some(ip); }
                    }
                }
                if lower.contains("default gateway") && info.gateway.is_none() {
                    if let Some(pos) = line.rfind(':') {
                        let gw = line[pos+1..].trim().to_string();
                        if !gw.is_empty() { info.gateway = Some(gw); }
                    }
                }
                if lower.contains("dns servers") {
                    if let Some(pos) = line.rfind(':') {
                        let dns = line[pos+1..].trim().to_string();
                        if !dns.is_empty() && !info.dns_servers.contains(&dns) {
                            info.dns_servers.push(dns);
                        }
                    }
                }
                if info.local_ip.is_some() && info.gateway.is_some() && !info.dns_servers.is_empty() {
                    break;
                }
            }
        }
    }

    info.dns_servers.truncate(2); // show at most 2
    if let Some(ref ip) = info.local_ip { info.dhcp = ping::is_private_ip(ip); }
    info
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SshState::new())
        .manage(local_pty::LocalPtyState::new())
        .invoke_handler(tauri::generate_handler![
            ping_host,
            detect_vpn,
            load_hosts,
            save_hosts,
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::ssh_send,
            ssh::ssh_resize,
            ssh::ssh_exec,
            ssh::sftp_list,
            ssh::sftp_download,
            ssh::sftp_mkdir,
            ssh::sftp_delete,
            ssh::sftp_rename,
            ssh::sftp_upload_bytes,
            ssh::get_metrics,
            ssh::probe_capabilities,
            ssh::invalidate_metrics_cache,
            ssh::get_iface_details,
            ssh::get_routes,
            ssh::run_speedtest,
            ssh::clear_host_key,
            ssh::trust_host_key,
            command_history::load_command_history,
            command_history::save_command,
            keys::list_ssh_keys,
            keys::generate_ssh_key,
            keys::delete_ssh_key,
            keys::regenerate_ssh_key,
            get_local_network_info,
            open_url,
            write_text_file,
            audit::append_audit_log,
            audit::load_audit_log,
            audit::clear_audit_log,
            http_client::make_http_request,
            ssh::tunnel_http_request,
            docker::docker_list_containers,
            docker::docker_container_action,
            docker::docker_logs_tail,
            docker::docker_compose_list,
            docker::docker_compose_action,
            docker::docker_prune,
            docker::docker_system_df,
            docker::docker_list_volumes,
            docker::docker_volume_inspect,
            docker::docker_volume_create,
            docker::docker_volume_remove,
            docker::docker_list_networks,
            docker::docker_network_inspect,
            docker::docker_network_create,
            docker::docker_network_remove,
            docker::docker_network_connect,
            docker::docker_network_disconnect,
            docker::docker_list_images,
            docker::docker_image_inspect,
            docker::docker_image_pull,
            docker::docker_image_remove,
            docker::docker_container_rebuild,
            local_pty::local_pty_start,
            local_pty::local_pty_send,
            local_pty::local_pty_resize,
            local_pty::local_pty_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pingnet");
}
