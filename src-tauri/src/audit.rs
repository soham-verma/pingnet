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
pub async fn append_audit_log(
    app: tauri::AppHandle,
    host_id: String,
    host: String,
    username: String,
    command: String,
    ts: u64,
) -> Result<String, String> {
    // Ignore blank/whitespace commands
    let cmd = command.trim().to_string();
    if cmd.is_empty() {
        return Ok(String::new());
    }

    // Never write inline credentials to the plaintext log (audit SEC-001)
    let stored = if crate::secrets::looks_sensitive(&cmd) { crate::secrets::redact(&cmd) } else { cmd };
    let entry = AuditEntry { ts, host, username, command: stored.clone() };
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
    drop(file);
    enforce_retention(&path)?;
    Ok(stored)
}

const MAX_AUDIT_ENTRIES: usize = 5000;
const TRIM_AT_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_LOAD_LIMIT: usize = 500;

fn read_entries(path: &std::path::Path) -> Result<Vec<AuditEntry>, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Cannot read audit log: {}", e))?;
    Ok(content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<AuditEntry>(l).ok())
        .collect())
}

fn write_entries_atomic(path: &std::path::Path, entries: &[AuditEntry]) -> Result<(), String> {
    let mut out = String::new();
    for e in entries {
        out.push_str(&serde_json::to_string(e).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    let tmp = path.with_extension("jsonl.tmp");
    fs::write(&tmp, out).map_err(|e| format!("Cannot write audit log: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("Cannot commit audit log: {}", e))
}

/// Redact credentials recorded by older versions and cap the entry count.
/// Returns true when the entries were modified.
fn sanitize(entries: &mut Vec<AuditEntry>) -> bool {
    let mut changed = false;
    for e in entries.iter_mut() {
        if crate::secrets::looks_sensitive(&e.command) {
            e.command = crate::secrets::redact(&e.command);
            changed = true;
        }
    }
    if entries.len() > MAX_AUDIT_ENTRIES {
        entries.drain(..entries.len() - MAX_AUDIT_ENTRIES);
        changed = true;
    }
    changed
}

/// Trim the file once it grows past TRIM_AT_BYTES (called after appends).
fn enforce_retention(path: &std::path::Path) -> Result<(), String> {
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size <= TRIM_AT_BYTES {
        return Ok(());
    }
    let mut entries = read_entries(path)?;
    sanitize(&mut entries);
    // Keep headroom so we don't rewrite on every append
    if entries.len() > MAX_AUDIT_ENTRIES / 2 && size > TRIM_AT_BYTES {
        let keep = entries.len().min(MAX_AUDIT_ENTRIES) * 3 / 4;
        entries.drain(..entries.len() - keep);
    }
    write_entries_atomic(path, &entries)
}

/// Load the most recent `limit` entries (oldest first). Runs off the main
/// thread; also migrates older logs by redacting any stored credentials.
#[tauri::command]
pub async fn load_audit_log(
    app: tauri::AppHandle,
    host_id: String,
    limit: Option<usize>,
) -> Result<Vec<AuditEntry>, String> {
    let path = audit_file(&app, &host_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !path.exists() {
            return Ok(vec![]);
        }
        let mut entries = read_entries(&path)?;
        if sanitize(&mut entries) {
            write_entries_atomic(&path, &entries)?;
        }
        let limit = limit.unwrap_or(DEFAULT_LOAD_LIMIT).min(MAX_AUDIT_ENTRIES);
        let skip = entries.len().saturating_sub(limit);
        Ok(entries.into_iter().skip(skip).collect())
    })
    .await
    .map_err(|e| e.to_string())?
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

#[cfg(test)]
mod tests {
    use super::*;

    fn e(cmd: &str) -> AuditEntry {
        AuditEntry { ts: 1, host: "h".into(), username: "u".into(), command: cmd.into() }
    }

    #[test]
    fn sanitize_redacts_legacy_secrets() {
        let mut v = vec![e("ls"), e("mysql -phunter2 db")];
        assert!(sanitize(&mut v));
        assert_eq!(v[0].command, "ls");
        assert!(!v[1].command.contains("hunter2"));
        assert!(!sanitize(&mut v)); // idempotent
    }

    #[test]
    fn sanitize_caps_entry_count_keeping_newest() {
        let mut v: Vec<AuditEntry> = (0..MAX_AUDIT_ENTRIES + 10).map(|i| e(&format!("echo {}", i))).collect();
        sanitize(&mut v);
        assert_eq!(v.len(), MAX_AUDIT_ENTRIES);
        assert_eq!(v.last().unwrap().command, format!("echo {}", MAX_AUDIT_ENTRIES + 9));
    }
}
