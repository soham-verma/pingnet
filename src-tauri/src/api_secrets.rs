//! OS-keychain storage for API-client secrets (header values, env vars).
//! The webview persists only references like "api:<host>:<field>" (SEC-005).

use keyring::Entry;

const SERVICE: &str = "pingnet-api";

fn validate(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 200 || !key.starts_with("api:")
        || !key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
    {
        return Err("Invalid secret key".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn api_secret_set(key: String, value: String) -> Result<(), String> {
    validate(&key)?;
    tauri::async_runtime::spawn_blocking(move || {
        Entry::new(SERVICE, &key).map_err(|e| e.to_string())?
            .set_password(&value).map_err(|e| format!("Keychain write failed: {}", e))
    }).await.map_err(|e| e.to_string())?
}

/// Returns None when no secret is stored under `key`.
#[tauri::command]
pub async fn api_secret_get(key: String) -> Result<Option<String>, String> {
    validate(&key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Keychain read failed: {}", e)),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn api_secret_delete(key: String) -> Result<(), String> {
    validate(&key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.delete_password() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Keychain delete failed: {}", e)),
        }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn key_validation() {
        assert!(super::validate("api:host-1:abc_def").is_ok());
        assert!(super::validate("pingnet-ssh:x").is_err()); // can't reach SSH key entries
        assert!(super::validate("api:../x").is_err());
        assert!(super::validate("").is_err());
    }
}
