use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HostConfig {
    pub id: String,
    pub hostname: String,
    pub ip: String,
    pub notes: Option<String>,
    pub created_at: u64,
    // Alert settings — all default to false/None so existing JSON deserialises cleanly
    #[serde(default)]
    pub alert_on_down: bool,
    #[serde(default)]
    pub alert_on_recovery: bool,
    #[serde(default)]
    pub alert_latency_ms: Option<u64>,
}

fn hosts_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {}", e))?;
    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Cannot create app data dir: {}", e))?;
    Ok(data_dir.join("hosts.json"))
}

pub fn load_hosts(app: &tauri::AppHandle) -> Result<Vec<HostConfig>, String> {
    let path = hosts_file_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read hosts file: {}", e))?;

    // Try to parse the whole file; if that fails, try parsing individual
    // entries so a single corrupt record doesn't wipe the entire host list.
    match serde_json::from_str::<Vec<HostConfig>>(&content) {
        Ok(hosts) => Ok(hosts),
        Err(_) => {
            // Attempt partial recovery: parse as raw array and skip bad entries
            if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                let recovered: Vec<HostConfig> = arr
                    .into_iter()
                    .filter_map(|v| serde_json::from_value(v).ok())
                    .collect();
                if !recovered.is_empty() {
                    return Ok(recovered);
                }
            }
            Err("hosts.json is corrupted; starting fresh".to_string())
        }
    }
}

pub fn save_hosts(app: &tauri::AppHandle, hosts: &[HostConfig]) -> Result<(), String> {
    let path = hosts_file_path(app)?;
    let content = serde_json::to_string_pretty(hosts)
        .map_err(|e| format!("Cannot serialize hosts: {}", e))?;

    // Atomic write: write to a temp file then rename so a mid-write crash
    // cannot corrupt the existing hosts.json.
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &content)
        .map_err(|e| format!("Cannot write temp hosts file: {}", e))?;
    fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Cannot commit hosts file: {}", e))?;
    Ok(())
}
