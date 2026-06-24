use keyring::Entry;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::fs;
use tauri::Manager;

const KEYCHAIN_SERVICE: &str = "pingnet-ssh";

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KeyInfo {
    pub name: String,
    pub public_key: String,
    pub comment: String,
    pub created_at: u64,
}

// ── Key index (names + public keys stored on disk, private keys in keychain) ──

fn key_index_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir")
        .join("ssh_keys.json")
}

fn load_key_index(app: &tauri::AppHandle) -> Vec<KeyInfo> {
    let path = key_index_path(app);
    if !path.exists() {
        return vec![];
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_key_index(app: &tauri::AppHandle, keys: &[KeyInfo]) {
    let path = key_index_path(app);
    if let Ok(json) = serde_json::to_string_pretty(keys) {
        let _ = fs::write(path, json);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_ssh_keys(app: tauri::AppHandle) -> Vec<KeyInfo> {
    load_key_index(&app)
}

/// Generate a new Ed25519 keypair, store private key in OS keychain,
/// return the OpenSSH public key string.
#[tauri::command]
pub fn generate_ssh_key(
    app: tauri::AppHandle,
    name: String,
    comment: String,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Key name cannot be empty".to_string());
    }

    // Generate Ed25519 keypair
    let private_key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
        .map_err(|e| format!("Key generation failed: {}", e))?;

    let private_pem = private_key
        .to_openssh(LineEnding::LF)
        .map_err(|e| format!("Failed to encode private key: {}", e))?
        .to_string();

    // Build public key with comment
    let mut pub_key = private_key.public_key().clone();
    pub_key.set_comment(comment.trim());
    let public_openssh = pub_key
        .to_openssh()
        .map_err(|e| format!("Failed to encode public key: {}", e))?;

    // Store private key in OS keychain
    let entry = Entry::new(KEYCHAIN_SERVICE, name.trim())
        .map_err(|e| format!("Keychain error: {}", e))?;
    entry
        .set_password(&private_pem)
        .map_err(|e| format!("Failed to store key in keychain: {}", e))?;

    // Update the on-disk index (public keys only)
    let mut keys = load_key_index(&app);
    keys.retain(|k| k.name != name.trim());
    keys.push(KeyInfo {
        name: name.trim().to_string(),
        public_key: public_openssh.clone(),
        comment: comment.trim().to_string(),
        created_at: now_ms(),
    });
    save_key_index(&app, &keys);

    Ok(public_openssh)
}

#[tauri::command]
pub fn delete_ssh_key(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, name.trim())
        .map_err(|e| format!("Keychain error: {}", e))?;
    // Ignore "not found" errors — just clean up the index either way
    let _ = entry.delete_password();

    let mut keys = load_key_index(&app);
    keys.retain(|k| k.name != name.trim());
    save_key_index(&app, &keys);
    Ok(())
}

// ── Internal helper (used by ssh.rs for KeychainKey auth) ─────────────────────

pub fn get_private_key(name: &str) -> Result<String, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, name)
        .map_err(|e| format!("Keychain error: {}", e))?;
    entry
        .get_password()
        .map_err(|e| format!("Key '{}' not found in keychain: {}", name, e))
}
