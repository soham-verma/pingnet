use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuditEntry {
    pub ts: u64,           // Unix ms
    pub host: String,
    pub username: String,
    pub command: String,
}

fn audit_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {}", e))?;
    let audit_dir = data_dir.join("audit");
    fs::create_dir_all(&audit_dir)
        .map_err(|e| format!("Cannot create audit dir: {}", e))?;
    Ok(audit_dir)
}

fn audit_file(app: &tauri::AppHandle, host_id: &str) -> Result<std::path::PathBuf, String> {
    // Sanitise host_id: allow only alphanumeric, dash, underscore
    if !host_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Invalid host_id for audit log: {}", host_id));
    }
    Ok(audit_dir(app)?.join(format!("{}.jsonl", host_id)))
}

#[tauri::command]
pub fn append_audit_log(
    app: tauri::AppHandle,
    host_id: String,
    host: String,
    username: String,
    command: String,
    ts: u64,
) -> Result<(), String> {
    // Ignore blank/whitespace commands
    let cmd = command.trim().to_string();
    if cmd.is_empty() {
        return Ok(());
    }

    let entry = AuditEntry { ts, host, username, command: cmd };
    let line = serde_json::to_string(&entry)
        .map_err(|e| format!("Cannot serialise audit entry: {}", e))?;

    let path = audit_file(&app, &host_id)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Cannot open audit log: {}", e))?;
    writeln!(file, "{}", line)
        .map_err(|e| format!("Cannot write audit log: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn load_audit_log(
    app: tauri::AppHandle,
    host_id: String,
) -> Result<Vec<AuditEntry>, String> {
    let path = audit_file(&app, &host_id)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read audit log: {}", e))?;

    let entries = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
        .collect();
    Ok(entries)
}

#[tauri::command]
pub fn clear_audit_log(app: tauri::AppHandle, host_id: String) -> Result<(), String> {
    let path = audit_file(&app, &host_id)?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Cannot clear audit log: {}", e))?;
    }
    Ok(())
}
