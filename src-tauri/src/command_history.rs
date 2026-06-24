use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandEntry {
    pub command: String,     // full command line as typed
    pub base_cmd: String,    // first word, e.g. "git", "docker"
    pub count: u32,          // times used
    pub first_seen: u64,     // ms since epoch
    pub last_seen: u64,      // ms since epoch
    pub help_summary: Option<String>,
}

type HistoryMap = HashMap<String, CommandEntry>;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn history_path(app: &AppHandle, host: &str) -> std::path::PathBuf {
    let dir = app.path().app_data_dir().expect("no app data dir");
    // Sanitise host string for use as a filename
    let safe: String = host
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    dir.join("history").join(format!("{}.json", safe))
}

fn load_raw(app: &AppHandle, host: &str) -> HistoryMap {
    let path = history_path(app, host);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_raw(app: &AppHandle, host: &str, map: &HistoryMap) {
    let path = history_path(app, host);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(&path, json);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Load all saved commands for a host, sorted most-recent first.
#[tauri::command]
pub fn load_command_history(app: AppHandle, host: String) -> Vec<CommandEntry> {
    let mut entries: Vec<CommandEntry> = load_raw(&app, &host).into_values().collect();
    entries.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));
    entries
}

/// Persist a command for a host.
///
/// Returns `true` if this is the first time the *base command* (e.g. "git")
/// has ever been seen for this host — useful to trigger a "new tool detected"
/// notification on the frontend.
#[tauri::command]
pub fn save_command(
    app: AppHandle,
    host: String,
    command: String,
    help_summary: Option<String>,
) -> bool {
    let cmd = command.trim().to_string();
    if cmd.is_empty() {
        return false;
    }

    // Don't persist commands that likely carry inline secrets (passwords, tokens, etc.)
    // to avoid plaintext credential exposure in the history JSON files.
    //
    // Patterns checked (case-insensitive on the full command string):
    //   1. Long-form CLI flags:  --password, --token, etc.
    //   2. Short password flags: -p<value> used by mysql, sshpass, etc.
    //   3. Assignment-style:     PASSWORD=..., TOKEN=..., AWS_SECRET=...
    //   4. URL userinfo:         https://user:pass@host  (any scheme)
    //   5. curl -u user:pass
    //   6. sshpass wrapper
    let lower = cmd.to_lowercase();

    // Long-form flag patterns
    let flag_patterns = [
        "--password", "--passwd", "--pass",
        "--token", "--secret", "--api-key", "--apikey",
        "--auth-token", "--access-token", "--private-key",
        "--client-secret", "--aws-secret",
    ];
    if flag_patterns.iter().any(|p| lower.contains(p)) {
        return false;
    }

    // sshpass / ssh-pass wrapper
    if lower.starts_with("sshpass") || lower.contains(" sshpass ") {
        return false;
    }

    // curl -u user:pass  (short -u flag followed by non-whitespace containing colon)
    if lower.contains("curl") {
        // Look for "-u " or "-u:" followed by something with a colon (basic-auth)
        let has_curl_u = lower.contains(" -u ") || lower.contains("\t-u ");
        if has_curl_u {
            return false;
        }
    }

    // Short -p<value> flag used by mysql, mysqldump, sshpass, etc.
    // Match: -p followed immediately by a non-whitespace, non-hyphen char.
    // This catches `-pmysecret` but not `-port` or `--pass`.
    {
        let bytes = lower.as_bytes();
        for i in 0..bytes.len().saturating_sub(2) {
            if bytes[i] == b' ' || i == 0 {
                let off = if i == 0 { 0 } else { i + 1 };
                if bytes.get(off) == Some(&b'-')
                    && bytes.get(off + 1) == Some(&b'p')
                    && bytes.get(off + 2).map(|&c| c != b' ' && c != b'-' && c != b'\t').unwrap_or(false)
                {
                    return false;
                }
            }
        }
    }

    // Environment-variable-style secrets: KEY=value at the start of a word.
    // Catches: TOKEN=abc, PASSWORD=..., SECRET=..., AWS_SECRET_ACCESS_KEY=...
    let secret_env_substrings = [
        "password=", "passwd=", "pass=", "token=", "secret=",
        "apikey=", "api_key=", "authtoken=", "auth_token=",
        "access_token=", "private_key=", "client_secret=",
        "aws_secret", "aws_access_key",
    ];
    if secret_env_substrings.iter().any(|p| lower.contains(p)) {
        return false;
    }

    // URL userinfo: scheme://user:pass@host
    // Look for "://" followed anywhere by "@" with a ":" between them.
    if let Some(scheme_end) = lower.find("://") {
        let after = &lower[scheme_end + 3..];
        if let Some(at_pos) = after.find('@') {
            let before_at = &after[..at_pos];
            // If there's a colon before the @, there are credentials in the URL
            if before_at.contains(':') {
                return false;
            }
        }
    }

    let base_cmd = cmd
        .split_whitespace()
        .next()
        .unwrap_or(&cmd)
        .to_string();

    let mut map = load_raw(&app, &host);

    // Is this the very first time we've seen this base command for this host?
    let is_new_base = !map.values().any(|e| e.base_cmd == base_cmd);

    let ts = now_ms();
    let entry = map.entry(cmd.clone()).or_insert_with(|| CommandEntry {
        command: cmd.clone(),
        base_cmd: base_cmd.clone(),
        count: 0,
        first_seen: ts,
        last_seen: ts,
        help_summary: None,
    });
    entry.count += 1;
    entry.last_seen = ts;
    // Only store help once — never overwrite a stored description
    if entry.help_summary.is_none() {
        entry.help_summary = help_summary;
    }

    // Cap at 500 entries — evict least-recently-used when over limit (task #13)
    const MAX_ENTRIES: usize = 500;
    if map.len() > MAX_ENTRIES {
        // Collect keys sorted by last_seen ascending (oldest first), drop the tail
        let mut keys_by_age: Vec<(String, u64)> = map
            .iter()
            .map(|(k, v)| (k.clone(), v.last_seen))
            .collect();
        keys_by_age.sort_by_key(|(_, ts)| *ts);
        let to_remove = map.len() - MAX_ENTRIES;
        for (k, _) in keys_by_age.into_iter().take(to_remove) {
            map.remove(&k);
        }
    }

    save_raw(&app, &host, &map);
    is_new_base
}
