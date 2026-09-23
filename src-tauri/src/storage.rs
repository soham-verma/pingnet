use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// A secondary IP address associated with a host (for reference/display only).
/// The primary `ip` field is always used for pinging.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HostIp {
    pub address: String,
    /// Role label: "local" | "wifi" | "vpn" | "public" | "tailscale" | "other"
    #[serde(rename = "type")]
    pub ip_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HostConfig {
    pub id: String,
    pub hostname: String,
    /// The active IP used for pinging
    pub ip: String,
    /// Type/role label for the active IP
    #[serde(default)]
    pub ip_type: Option<String>,
    /// Additional IPs — stored for reference; not pinged automatically
    #[serde(default)]
    pub extra_ips: Vec<HostIp>,
    pub notes: Option<String>,
    pub created_at: u64,
    // Alert settings — all default to false/None so existing JSON deserialises cleanly
    #[serde(default)]
    pub alert_on_down: bool,
    #[serde(default)]
    pub alert_on_recovery: bool,
    #[serde(default)]
    pub alert_latency_ms: Option<u64>,
    // SSH connection config — persisted so the user doesn't re-enter on every launch.
    // All optional so existing hosts.json deserialises without migration.
    // Passwords and key passphrases are NEVER stored here.
    #[serde(default)]
    pub ssh_port: Option<u16>,
    #[serde(default)]
    pub ssh_username: Option<String>,
    #[serde(default)]
    pub ssh_auth_type: Option<String>,   // "password" | "key" | "keychain" | "agent" | "totp"
    #[serde(default)]
    pub ssh_key_path: Option<String>,
    #[serde(default)]
    pub ssh_key_name: Option<String>,
    /// Sidebar folder this host belongs to (`None` = ungrouped). A dangling id
    /// (folder since deleted) is treated as ungrouped by the frontend.
    #[serde(default)]
    pub folder_id: Option<String>,
}

/// A user-defined sidebar folder. Folder order is the order of the array in
/// folders.json; host order within a folder is the order of hosts.json.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HostFolder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub collapsed: bool,
}

fn data_file_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {}", e))?;
    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Cannot create app data dir: {}", e))?;
    Ok(data_dir.join(name))
}

fn hosts_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    data_file_path(app, "hosts.json")
}

/// Atomic write: write to a temp file then rename so a mid-write crash
/// cannot corrupt the existing file.
fn write_atomic(path: &PathBuf, content: &str) -> Result<(), String> {
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, content)
        .map_err(|e| format!("Cannot write temp file {}: {}", tmp_path.display(), e))?;
    fs::rename(&tmp_path, path)
        .map_err(|e| format!("Cannot commit {}: {}", path.display(), e))
}

/// Result of loading a data file. `warning` is set when the file was damaged:
/// the original is preserved as `<name>.corrupt-<unix-ms>` before anything is
/// dropped, so recovery never destroys data.
#[derive(Debug, Serialize)]
pub struct Loaded<T> {
    pub items: Vec<T>,
    pub warning: Option<String>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Copy a damaged file aside (never moved — the original stays until the next
/// successful save replaces it) and return the backup path.
fn preserve_corrupt(path: &PathBuf) -> Result<PathBuf, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let backup = path.with_file_name(format!("{}.corrupt-{}", name, now_ms()));
    fs::copy(path, &backup)
        .map_err(|e| format!("Cannot back up damaged {}: {}", name, e))?;
    Ok(backup)
}

/// Parse a JSON array, recovering valid entries from a partly-damaged file.
/// Returns Err only when the file cannot be READ — callers must then refuse to
/// overwrite it (a later save would destroy data we never looked at).
fn load_array<T: serde::de::DeserializeOwned>(path: &PathBuf, label: &str) -> Result<Loaded<T>, String> {
    if !path.exists() {
        return Ok(Loaded { items: Vec::new(), warning: None });
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Cannot read {}: {}", label, e))?;

    if let Ok(items) = serde_json::from_str::<Vec<T>>(&content) {
        return Ok(Loaded { items, warning: None });
    }

    // Damaged: keep a copy of exactly what was on disk before recovering
    let backup = preserve_corrupt(path)?;
    let (items, total) = match serde_json::from_str::<Vec<serde_json::Value>>(&content) {
        Ok(arr) => {
            let total = arr.len();
            (arr.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect::<Vec<T>>(), total)
        }
        Err(_) => (Vec::new(), 0),
    };
    let warning = if total > 0 {
        format!(
            "{} was damaged: recovered {} of {} entries. The original was saved to {}.",
            label, items.len(), total, backup.display()
        )
    } else {
        format!("{} could not be parsed and was reset. The original was saved to {}.", label, backup.display())
    };
    Ok(Loaded { items, warning: Some(warning) })
}

pub fn load_hosts(app: &tauri::AppHandle) -> Result<Loaded<HostConfig>, String> {
    load_array(&hosts_file_path(app)?, "hosts.json")
}

pub fn save_hosts(app: &tauri::AppHandle, hosts: &[HostConfig]) -> Result<(), String> {
    let path = hosts_file_path(app)?;
    let content = serde_json::to_string_pretty(hosts)
        .map_err(|e| format!("Cannot serialize hosts: {}", e))?;

    write_atomic(&path, &content)
}

pub fn load_folders(app: &tauri::AppHandle) -> Result<Loaded<HostFolder>, String> {
    load_array(&data_file_path(app, "folders.json")?, "folders.json")
}

pub fn save_folders(app: &tauri::AppHandle, folders: &[HostFolder]) -> Result<(), String> {
    let path = data_file_path(app, "folders.json")?;
    let content = serde_json::to_string_pretty(folders)
        .map_err(|e| format!("Cannot serialize folders: {}", e))?;
    write_atomic(&path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, content: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pn-storage-{}-{}", name, now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("hosts.json");
        fs::write(&p, content).unwrap();
        p
    }

    fn backups(p: &PathBuf) -> Vec<PathBuf> {
        fs::read_dir(p.parent().unwrap()).unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|x| x.to_string_lossy().contains(".corrupt-"))
            .collect()
    }

    #[test]
    fn missing_file_is_empty_without_warning() {
        let p = std::env::temp_dir().join("pn-does-not-exist-xyz.json");
        let l: Loaded<HostFolder> = load_array(&p, "x").unwrap();
        assert!(l.items.is_empty() && l.warning.is_none());
    }

    #[test]
    fn valid_file_loads_without_backup() {
        let p = tmp("ok", r#"[{"id":"a","name":"A","collapsed":false}]"#);
        let l: Loaded<HostFolder> = load_array(&p, "folders.json").unwrap();
        assert_eq!(l.items.len(), 1);
        assert!(l.warning.is_none());
        assert!(backups(&p).is_empty());
    }

    #[test]
    fn partial_recovery_preserves_original_and_warns() {
        let raw = r#"[{"id":"a","name":"A","collapsed":false},{"id":5},{"id":"c","name":"C"}]"#;
        let p = tmp("partial", raw);
        let l: Loaded<HostFolder> = load_array(&p, "folders.json").unwrap();
        assert_eq!(l.items.len(), 2);
        assert!(l.warning.as_deref().unwrap().contains("recovered 2 of 3"));
        let b = backups(&p);
        assert_eq!(b.len(), 1);
        assert_eq!(fs::read_to_string(&b[0]).unwrap(), raw);
    }

    #[test]
    fn unparseable_file_is_backed_up_before_reset() {
        let p = tmp("garbage", "{not json");
        let l: Loaded<HostFolder> = load_array(&p, "folders.json").unwrap();
        assert!(l.items.is_empty());
        assert!(l.warning.is_some());
        assert_eq!(fs::read_to_string(&backups(&p)[0]).unwrap(), "{not json");
    }
}
