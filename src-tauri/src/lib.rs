mod command_history;
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
            write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pingnet");
}
