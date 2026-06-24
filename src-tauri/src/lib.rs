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
fn ping_host(ip: String) -> PingResult {
    ping::ping(&ip)
}

#[tauri::command]
fn detect_vpn() -> VpnStatus {
    vpn::detect_vpn()
}

#[tauri::command]
fn load_hosts(app: tauri::AppHandle) -> Result<Vec<HostConfig>, String> {
    storage::load_hosts(&app)
}

#[tauri::command]
fn save_hosts(app: tauri::AppHandle, hosts: Vec<HostConfig>) -> Result<(), String> {
    storage::save_hosts(&app, &hosts)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
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
            ssh::sftp_upload,
            ssh::sftp_mkdir,
            ssh::sftp_delete,
            ssh::sftp_rename,
            ssh::sftp_upload_bytes,
            ssh::get_metrics,
            ssh::probe_capabilities,
            ssh::invalidate_metrics_cache,
            command_history::load_command_history,
            command_history::save_command,
            keys::list_ssh_keys,
            keys::generate_ssh_key,
            keys::delete_ssh_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pingnet");
}
