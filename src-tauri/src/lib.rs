mod audit;
mod command_history;
mod http_client;
mod keys;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SshState::new())
        .invoke_handler(tauri::generate_handler![
            ping_host,
            detect_vpn,
            load_hosts,
            save_hosts,
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::ssh_send,
            ssh::ssh_resize,
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
            open_url,
            write_text_file,
            audit::append_audit_log,
            audit::load_audit_log,
            audit::clear_audit_log,
            http_client::make_http_request,
            ssh::tunnel_http_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pingnet");
}
