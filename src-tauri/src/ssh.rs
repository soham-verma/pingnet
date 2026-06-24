use serde::{Deserialize, Serialize};
use ssh2::{Channel, MethodType, Session};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

// ── Public types sent over IPC ────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub permissions: String,
    pub modified: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransferProgress {
    pub id: String,
    pub name: String,
    pub kind: String, // "upload" | "download"
    pub bytes_done: u64,
    pub total_bytes: u64,
    pub status: String, // "running" | "done" | "error"
    pub error: Option<String>,
}

// ── Internal types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum SshAuth {
    Password { password: String },
    /// File-path based key (legacy / manual)
    Key { key_path: String, passphrase: Option<String> },
    /// Key stored in OS keychain via the Pingnet key manager
    KeychainKey { key_name: String },
    /// Delegate to the running SSH agent (SSH_AUTH_SOCK) — works with any key type
    Agent,
}

enum ShellMsg {
    Input(String),
    Resize(u32, u32),
    Stop,
}

pub struct SshConnection {
    shell_tx: mpsc::SyncSender<ShellMsg>,
    /// Separate session kept for SFTP — accessed only inside spawn_blocking
    sftp_session: Mutex<Session>,
    stop_flag: Arc<AtomicBool>,
}

pub struct SshState {
    pub sessions: tokio::sync::Mutex<HashMap<String, Arc<SshConnection>>>,
    pub metrics:  std::sync::Arc<crate::metrics::MetricsState>,
}

impl SshState {
    pub fn new() -> Self {
        Self {
            sessions: tokio::sync::Mutex::new(HashMap::new()),
            metrics:  crate::metrics::MetricsState::new(),
        }
    }
}

// ── Known-hosts TOFU store ────────────────────────────────────────────────────

fn known_hosts_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d: PathBuf| d.join("known_hosts.json"))
}

fn load_known_hosts(app: &tauri::AppHandle) -> HashMap<String, String> {
    let path = match known_hosts_path(app) {
        Some(p) => p,
        None => return HashMap::new(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_known_hosts(app: &tauri::AppHandle, map: &HashMap<String, String>) {
    if let Some(path) = known_hosts_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(map) {
            let _ = std::fs::write(path, json);
        }
    }
}

/// Trust-on-first-use host key verification.
/// First connection: fingerprint is stored and the connection proceeds.
/// Subsequent connections: fingerprint must match what was stored.
fn verify_host_key(session: &Session, host: &str, port: u16, app: &tauri::AppHandle) -> Result<(), String> {
    let hash = session
        .host_key_hash(ssh2::HashType::Md5)
        .ok_or_else(|| "Server provided no host key — refusing connection".to_string())?;

    let fingerprint = hash.iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(":");

    let host_key = format!("[{}]:{}", host, port);
    let mut known = load_known_hosts(app);

    match known.get(&host_key) {
        Some(stored) if stored != &fingerprint => {
            // Embed structured fields so the frontend can parse them without regex
            return Err(format!(
                "HOST_KEY_CHANGED\x00host={}\x00stored={}\x00current={}",
                host, stored, fingerprint
            ));
        }
        None => {
            // First time connecting to this host — store it (TOFU)
            known.insert(host_key, fingerprint);
            save_known_hosts(app, &known);
        }
        _ => {} // Key matches — all good
    }
    Ok(())
}

/// Remove a host's stored key so the next connection re-pins it (TOFU reset).
/// Call this when the user trusts the new key after a server reinstall.
#[tauri::command]
pub async fn clear_host_key(
    app: tauri::AppHandle,
    host: String,
    port: u16,
) -> Result<(), String> {
    let host_key = format!("[{}]:{}", host, port);
    let mut known = load_known_hosts(&app);
    known.remove(&host_key);
    save_known_hosts(&app, &known);
    Ok(())
}

/// Overwrite a host's stored key with the supplied fingerprint.
/// Used by the "Trust New Key" UI action — sets the current key as trusted
/// so the next connect() call succeeds without another mismatch error.
#[tauri::command]
pub async fn trust_host_key(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    fingerprint: String,
) -> Result<(), String> {
    let host_key = format!("[{}]:{}", host, port);
    let mut known = load_known_hosts(&app);
    known.insert(host_key, fingerprint);
    save_known_hosts(&app, &known);
    Ok(())
}

// ── Connection helpers ────────────────────────────────────────────────────────

fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    TcpStream::connect(format!("{}:{}", host, port))
        .map_err(|e| format!("TCP connect failed: {}", e))
}

/// libssh2 defaults can fail against modern OpenSSH (incl. Windows OpenSSH) which
/// prefers curve25519 / ssh-ed25519. Set explicit prefs before handshake.
fn configure_session_algorithms(session: &Session) {
    // Must include OpenSSH strict-KEX indicators when overriding defaults — without
    // these, OpenSSH 10.x servers reject the handshake (libssh2 #1326).
    let _ = session.method_pref(
        MethodType::Kex,
        "ext-info-c,kex-strict-c-v00@openssh.com,\
         curve25519-sha256,curve25519-sha256@libssh.org,\
         ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,\
         diffie-hellman-group-exchange-sha256,diffie-hellman-group16-sha512,\
         diffie-hellman-group18-sha512,diffie-hellman-group14-sha256",
    );
    let _ = session.method_pref(
        MethodType::HostKey,
        "ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256,ssh-rsa",
    );
    let _ = session.method_pref(
        MethodType::CryptCs,
        "chacha20-poly1305@openssh.com,aes128-ctr,aes256-ctr,\
         aes128-gcm@openssh.com,aes256-gcm@openssh.com",
    );
    let _ = session.method_pref(
        MethodType::CryptSc,
        "chacha20-poly1305@openssh.com,aes128-ctr,aes256-ctr,\
         aes128-gcm@openssh.com,aes256-gcm@openssh.com",
    );
    let _ = session.method_pref(
        MethodType::MacCs,
        "hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com,\
         hmac-sha2-256,hmac-sha2-512",
    );
    let _ = session.method_pref(
        MethodType::MacSc,
        "hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com,\
         hmac-sha2-256,hmac-sha2-512",
    );
}

fn make_session(stream: TcpStream, host: &str, port: u16, app: &tauri::AppHandle) -> Result<Session, String> {
    let mut session = Session::new().map_err(|e| format!("Session init failed: {}", e))?;
    configure_session_algorithms(&session);
    session.set_tcp_stream(stream);
    session.handshake().map_err(|e| format!("SSH handshake failed: {}", e))?;
    verify_host_key(&session, host, port, app)?;
    Ok(session)
}

fn auth_session(session: &Session, username: &str, auth: &SshAuth) -> Result<(), String> {
    match auth {
        SshAuth::Password { password } => {
            session
                .userauth_password(username, password)
                .map_err(|e| format!("Password auth failed: {}", e))?;
        }
        SshAuth::Key { key_path, passphrase } => {
            // Expand `~/` and `$HOME/` — the shell does this automatically but Rust doesn't.
            // dirs::home_dir() works cross-platform: $HOME on Unix, %USERPROFILE% on Windows.
            let expanded: PathBuf = {
                let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
                if key_path.starts_with("~/") || key_path == "~" {
                    home.join(key_path.trim_start_matches("~/"))
                } else if key_path.starts_with("$HOME/") {
                    home.join(key_path.trim_start_matches("$HOME/"))
                } else {
                    PathBuf::from(key_path)
                }
            };
            // Read the key into memory and use userauth_pubkey_memory rather than
            // userauth_pubkey_file. The file-based libssh2 API has broken support for
            // the modern OpenSSH private key format (-----BEGIN OPENSSH PRIVATE KEY-----)
            // used by Ed25519 and newer RSA keys; the memory-based API does not.
            let key_data = std::fs::read_to_string(&expanded)
                .map_err(|e| format!("Cannot read key file {}: {}", expanded.display(), e))?;
            session
                .userauth_pubkey_memory(username, None, &key_data, passphrase.as_deref())
                .map_err(|e| format!("Key auth failed: {}", e))?;
        }
        SshAuth::KeychainKey { key_name } => {
            let private_pem = crate::keys::get_private_key(key_name)?;
            session
                .userauth_pubkey_memory(username, None, &private_pem, None)
                .map_err(|e| format!("Keychain key auth failed: {}", e))?;
        }
        SshAuth::Agent => {
            session
                .userauth_agent(username)
                .map_err(|e| format!("SSH agent auth failed: {}", e))?;
        }
    }
    if !session.authenticated() {
        return Err("Authentication rejected by server".to_string());
    }
    Ok(())
}

fn open_shell(session: &Session) -> Result<Channel, String> {
    let mut ch = session.channel_session()
        .map_err(|e| format!("Channel open failed: {}", e))?;
    ch.request_pty("xterm-256color", None, Some((220, 50, 0, 0)))
        .map_err(|e| format!("PTY request failed: {}", e))?;
    ch.shell().map_err(|e| format!("Shell request failed: {}", e))?;
    Ok(ch)
}

// ── Shell reader thread ───────────────────────────────────────────────────────

fn run_shell_thread(
    session: Session,
    mut channel: Channel,
    rx: mpsc::Receiver<ShellMsg>,
    app: tauri::AppHandle,
    session_id: String,
    stop_flag: Arc<AtomicBool>,
) {
    session.set_blocking(false);
    let mut buf = [0u8; 8192];

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        // Non-blocking read from shell
        match channel.read(&mut buf) {
            Ok(0) => {
                if channel.eof() {
                    break;
                }
            }
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                app.emit(&format!("ssh-output-{}", session_id), text).ok();
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }

        // Drain pending commands
        while let Ok(msg) = rx.try_recv() {
            match msg {
                ShellMsg::Input(data) => {
                    session.set_blocking(true);
                    channel.write_all(data.as_bytes()).ok();
                    channel.flush().ok();
                    session.set_blocking(false);
                }
                ShellMsg::Resize(cols, rows) => {
                    channel.request_pty_size(cols, rows, None, None).ok();
                }
                ShellMsg::Stop => {
                    stop_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }

        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        std::thread::sleep(Duration::from_millis(8));
    }

    let _ = channel.close();
    app.emit(&format!("ssh-closed-{}", session_id), ()).ok();
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    auth: SshAuth,
) -> Result<(), String> {
    // Disconnect any existing session first
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(old) = sessions.remove(&session_id) {
            old.stop_flag.store(true, Ordering::Relaxed);
            let _ = old.shell_tx.try_send(ShellMsg::Stop);
        }
    }

    // Clone values for thread use
    let host_c = host.clone();
    let username_c = username.clone();
    let auth_c = auth.clone();
    let session_id_c = session_id.clone();
    let app_c = app.clone();

    // Connect shell session (runs in background thread)
    let (shell_tx, shell_rx) = mpsc::sync_channel::<ShellMsg>(256);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_t = stop_flag.clone();

    tauri::async_runtime::spawn_blocking({
        let host = host_c.clone();
        let username = username_c.clone();
        let auth = auth_c.clone();
        let app_verify = app.clone();
        move || {
            let stream = tcp_connect(&host, port)?;
            let session = make_session(stream, &host, port, &app_verify)?;
            auth_session(&session, &username, &auth)?;
            let channel = open_shell(&session)?;
            std::thread::spawn(move || {
                run_shell_thread(session, channel, shell_rx, app_c, session_id_c, stop_flag_t);
            });
            Ok::<_, String>(())
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    // Connect SFTP session (separate TCP connection)
    let sftp_session = tauri::async_runtime::spawn_blocking({
        let host = host.clone();
        let username = username.clone();
        let auth = auth.clone();
        let app_verify = app.clone();
        move || {
            let stream = tcp_connect(&host, port)?;
            let session = make_session(stream, &host, port, &app_verify)?;
            auth_session(&session, &username, &auth)?;
            Ok::<_, String>(session)
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    let conn = Arc::new(SshConnection {
        shell_tx,
        sftp_session: Mutex::new(sftp_session),
        stop_flag,
    });

    state.sessions.lock().await.insert(session_id, conn);
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(conn) = sessions.remove(&session_id) {
        conn.stop_flag.store(true, Ordering::Relaxed);
        let _ = conn.shell_tx.try_send(ShellMsg::Stop);
    }
    // Clear cached probe so reconnect gets a fresh capability scan
    crate::metrics::invalidate_caps(&session_id, &state.metrics);
    Ok(())
}

#[tauri::command]
pub async fn ssh_send(
    state: tauri::State<'_, SshState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let conn = sessions.get(&session_id).ok_or("SSH session not found")?;
    conn.shell_tx
        .try_send(ShellMsg::Input(data))
        .map_err(|e| format!("Send failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    state: tauri::State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let conn = sessions.get(&session_id).ok_or("SSH session not found")?;
    let _ = conn.shell_tx.try_send(ShellMsg::Resize(cols, rows));
    Ok(())
}

// ── SFTP helpers ──────────────────────────────────────────────────────────────

fn format_permissions(mode: u32) -> String {
    let types = [("r", 0o400), ("w", 0o200), ("x", 0o100),
                 ("r", 0o040), ("w", 0o020), ("x", 0o010),
                 ("r", 0o004), ("w", 0o002), ("x", 0o001)];
    types.iter().map(|(c, m)| if mode & m != 0 { c } else { "-" }).collect()
}

fn get_conn(
    sessions: &HashMap<String, Arc<SshConnection>>,
    session_id: &str,
) -> Result<Arc<SshConnection>, String> {
    sessions.get(session_id).cloned().ok_or_else(|| "SSH session not found".to_string())
}

// ── SFTP commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sftp_list(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        let mut entries = sftp
            .readdir(Path::new(&path))
            .map_err(|e| format!("readdir failed: {}", e))?;

        entries.sort_by(|(pa, sa), (pb, sb)| {
            sb.file_type().is_dir().cmp(&sa.file_type().is_dir())
                .then_with(|| pa.file_name().cmp(&pb.file_name()))
        });

        Ok(entries
            .into_iter()
            .map(|(pb, stat)| {
                let name = pb.file_name().unwrap_or_default().to_string_lossy().to_string();
                let full = format!("{}/{}", path.trim_end_matches('/'), name);
                FileEntry {
                    name,
                    path: full,
                    size: stat.size.unwrap_or(0),
                    is_dir: stat.file_type().is_dir(),
                    is_symlink: stat.file_type().is_symlink(),
                    permissions: format_permissions(stat.perm.unwrap_or(0)),
                    modified: stat.mtime.unwrap_or(0),
                }
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sftp_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
    transfer_id: String,
) -> Result<String, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let sftp = session.sftp().map_err(|e| e.to_string())?;

        let remote_stat = sftp.stat(Path::new(&remote_path)).map_err(|e| e.to_string())?;
        let total_bytes = remote_stat.size.unwrap_or(0);

        // Sanitize the server-derived filename: strip path separators, null bytes,
        // and leading dots so a malicious server can't overwrite arbitrary files.
        let raw_name = Path::new(&remote_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let filename: String = raw_name
            .chars()
            .map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c })
            .collect::<String>()
            .trim_start_matches('.')
            .to_string();
        if filename.is_empty() {
            return Err("Remote filename is invalid".to_string());
        }

        let downloads = dirs::download_dir()
            .or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&downloads)
            .map_err(|e| format!("Cannot create downloads directory: {}", e))?;

        // Resolve a unique download path — never overwrite an existing file
        // and never follow a symlink that could redirect writes outside Downloads.
        let local_path = {
            let stem = Path::new(&filename)
                .file_stem().unwrap_or_default().to_string_lossy().to_string();
            let ext  = Path::new(&filename)
                .extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();

            let mut candidate = downloads.join(&filename);
            let mut counter = 1u32;
            loop {
                // Reject symlinks — a remote-controlled filename could redirect
                // e.g. "../../.bashrc" even after stripping separators above.
                if let Ok(meta) = candidate.symlink_metadata() {
                    if meta.file_type().is_symlink() {
                        let new_name = if ext.is_empty() {
                            format!("{} ({})", stem, counter)
                        } else {
                            format!("{} ({}){}", stem, counter, ext)
                        };
                        candidate = downloads.join(new_name);
                        counter += 1;
                        continue;
                    }
                }
                // Use create_new so there is no TOCTOU window between the exists
                // check and the open — if another file races us we increment.
                match std::fs::OpenOptions::new()
                    .write(true).create_new(true).open(&candidate)
                {
                    Ok(f) => break (candidate, f),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        let new_name = if ext.is_empty() {
                            format!("{} ({})", stem, counter)
                        } else {
                            format!("{} ({}){}", stem, counter, ext)
                        };
                        candidate = downloads.join(new_name);
                        counter += 1;
                    }
                    Err(e) => return Err(format!("Cannot create download file: {}", e)),
                }
            }
        };
        let (local_path, mut local_file) = local_path;
        let local_path = local_path.to_string_lossy().to_string();

        let mut remote_file = sftp.open(Path::new(&remote_path)).map_err(|e| e.to_string())?;

        let mut buf = [0u8; 65536];
        let mut bytes_done = 0u64;

        loop {
            match remote_file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    local_file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    bytes_done += n as u64;
                    app.emit("transfer-progress", TransferProgress {
                        id: transfer_id.clone(),
                        name: filename.clone(),
                        kind: "download".to_string(),
                        bytes_done,
                        total_bytes,
                        status: "running".to_string(),
                        error: None,
                    }).ok();
                }
                Err(e) => return Err(e.to_string()),
            }
        }

        app.emit("transfer-progress", TransferProgress {
            id: transfer_id,
            name: filename,
            kind: "download".to_string(),
            bytes_done,
            total_bytes,
            status: "done".to_string(),
            error: None,
        }).ok();

        Ok(local_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

// sftp_upload (path-based) has been removed.
// It accepted an arbitrary local_path from the webview which could exfiltrate
// ~/.ssh/id_rsa or any other file readable by the app if the webview were
// compromised.  All uploads now go through sftp_upload_bytes which receives
// file content directly from the Tauri file-picker dialog — the filesystem
// path never crosses the IPC boundary.

#[tauri::command]
pub async fn sftp_mkdir(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        sftp.mkdir(Path::new(&path), 0o755).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sftp_delete(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        if is_dir {
            sftp.rmdir(Path::new(&path)).map_err(|e| e.to_string())
        } else {
            sftp.unlink(Path::new(&path)).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Upload raw bytes from the browser file input (no OS path available in webview)
#[tauri::command]
pub async fn sftp_upload_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    bytes: Vec<u8>,
    remote_path: String,
    transfer_id: String,
    local_name: String,
) -> Result<(), String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    let total_bytes = bytes.len() as u64;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        let mut remote_file = sftp
            .create(Path::new(&remote_path))
            .map_err(|e| format!("Cannot create remote file: {}", e))?;
        remote_file.write_all(&bytes).map_err(|e| e.to_string())?;
        app.emit("transfer-progress", TransferProgress {
            id: transfer_id,
            name: local_name,
            kind: "upload".to_string(),
            bytes_done: total_bytes,
            total_bytes,
            status: "done".to_string(),
            error: None,
        }).ok();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Collect metrics from a connected host (CPU, RAM, disk, net, GPU, processes…).
/// Uses the existing SFTP session — no extra TCP connection needed.
/// Frontend polls this every 3 s when the metrics tab is visible.
#[tauri::command]
pub async fn get_metrics(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<crate::metrics::MetricsSnapshot, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    let metrics_arc = std::sync::Arc::clone(&state.metrics);
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        crate::metrics::collect(&session, &session_id, &metrics_arc)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return cached capabilities for a session (probed on first get_metrics call).
/// Frontend can call this after connecting to know what the host supports.
#[tauri::command]
pub async fn probe_capabilities(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<crate::metrics::Capabilities, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    let metrics_arc = std::sync::Arc::clone(&state.metrics);
    tauri::async_runtime::spawn_blocking(move || {
        // Force a fresh probe (or return cached)
        let mut caps_map = metrics_arc.caps.lock().unwrap();
        if !caps_map.contains_key(&session_id) {
            let session = conn.sftp_session.lock().unwrap();
            let c = crate::metrics::probe(&session);
            caps_map.insert(session_id.clone(), c);
        }
        Ok(caps_map.get(&session_id).unwrap().clone())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Clear cached probe + samples for a session (call after reconnect).
#[tauri::command]
pub async fn invalidate_metrics_cache(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<(), String> {
    crate::metrics::invalidate_caps(&session_id, &state.metrics);
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: tauri::State<'_, SshState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        sftp.rename(Path::new(&old_path), Path::new(&new_path), None)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Routing table ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RouteEntry {
    pub destination: String,
    pub gateway:     String,
    pub iface:       String,
    pub metric:      Option<i64>,
    pub flags:       String,
}

#[tauri::command]
pub async fn get_routes(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<Vec<RouteEntry>, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        // Try `ip route show` first (more reliable), fall back to /proc/net/route
        let script = r#"
ip route show 2>/dev/null | awk '
{
  dest=$1; gw=""; iface=""; metric=""; flags=""
  for(i=2;i<=NF;i++){
    if($i=="via"){gw=$(i+1); i++}
    else if($i=="dev"){iface=$(i+1); i++}
    else if($i=="metric"){metric=$(i+1); i++}
  }
  if(dest=="default") flags="UG"; else flags="U"
  print dest"|"gw"|"iface"|"metric"|"flags
}' 2>/dev/null || \
awk 'NR>1{
  printf "%d.%d.%d.%d|%d.%d.%d.%d|%s|%s|%s\n",
    strtonum("0x"substr($2,7,2)),strtonum("0x"substr($2,5,2)),
    strtonum("0x"substr($2,3,2)),strtonum("0x"substr($2,1,2)),
    strtonum("0x"substr($3,7,2)),strtonum("0x"substr($3,5,2)),
    strtonum("0x"substr($3,3,2)),strtonum("0x"substr($3,1,2)),
    $1,$8,$4
}' /proc/net/route 2>/dev/null
"#;
        let mut ch = session.channel_session().map_err(|e| e.to_string())?;
        ch.exec(script).map_err(|e| e.to_string())?;
        let mut raw = String::new();
        ch.read_to_string(&mut raw).map_err(|e| e.to_string())?;
        let _ = ch.close();

        let routes = raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                let parts: Vec<&str> = l.splitn(5, '|').collect();
                RouteEntry {
                    destination: parts.first().unwrap_or(&"").trim().to_string(),
                    gateway:     parts.get(1).unwrap_or(&"").trim().to_string(),
                    iface:       parts.get(2).unwrap_or(&"").trim().to_string(),
                    metric:      parts.get(3).and_then(|s| s.trim().parse().ok()),
                    flags:       parts.get(4).unwrap_or(&"").trim().to_string(),
                }
            })
            .filter(|r| !r.destination.is_empty())
            .collect();

        Ok(routes)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Interface detail ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IfaceDetails {
    pub name: String,
    pub mac: Option<String>,
    pub mtu: Option<u32>,
    pub operstate: Option<String>,
    /// Link speed in Mbps; -1 = not available (virtual/CAN/etc.)
    pub speed_mbps: Option<i64>,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_packets: u64,
    pub tx_packets: u64,
    pub rx_errors: u64,
    pub tx_errors: u64,
    pub rx_dropped: u64,
    pub tx_dropped: u64,
    pub driver: Option<String>,
    pub bus_info: Option<String>,
}

fn parse_u64(s: &str) -> u64 { s.trim().parse().unwrap_or(0) }
fn parse_i64(s: &str) -> i64 { s.trim().parse().unwrap_or(-1) }

fn collect_iface_details(session: &Session, iface: &str) -> Result<IfaceDetails, String> {
    // Sanitise: only allow interface-name chars
    if !iface.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_') {
        return Err("Invalid interface name".to_string());
    }

    let script = format!(r#"
N="{iface}"
echo "MAC=$(cat /sys/class/net/$N/address 2>/dev/null)"
echo "MTU=$(cat /sys/class/net/$N/mtu 2>/dev/null)"
echo "STATE=$(cat /sys/class/net/$N/operstate 2>/dev/null)"
echo "SPEED=$(cat /sys/class/net/$N/speed 2>/dev/null || echo -1)"
echo "RX_BYTES=$(cat /sys/class/net/$N/statistics/rx_bytes 2>/dev/null || echo 0)"
echo "TX_BYTES=$(cat /sys/class/net/$N/statistics/tx_bytes 2>/dev/null || echo 0)"
echo "RX_PKTS=$(cat /sys/class/net/$N/statistics/rx_packets 2>/dev/null || echo 0)"
echo "TX_PKTS=$(cat /sys/class/net/$N/statistics/tx_packets 2>/dev/null || echo 0)"
echo "RX_ERR=$(cat /sys/class/net/$N/statistics/rx_errors 2>/dev/null || echo 0)"
echo "TX_ERR=$(cat /sys/class/net/$N/statistics/tx_errors 2>/dev/null || echo 0)"
echo "RX_DROP=$(cat /sys/class/net/$N/statistics/rx_dropped 2>/dev/null || echo 0)"
echo "TX_DROP=$(cat /sys/class/net/$N/statistics/tx_dropped 2>/dev/null || echo 0)"
ip addr show dev $N 2>/dev/null | grep -E '^\s+inet ' | awk '{{print "IPV4="$2}}'
ip addr show dev $N 2>/dev/null | grep -E '^\s+inet6 ' | awk '{{print "IPV6="$2}}'
ethtool -i $N 2>/dev/null | grep -E '^driver:|^bus-info:' | while IFS=': ' read k v; do
  case "$k" in driver) echo "DRIVER=$v";; bus-info) echo "BUS=$v";; esac
done
"#, iface = iface);

    let mut ch = session.channel_session().map_err(|e| e.to_string())?;
    ch.exec(&script).map_err(|e| e.to_string())?;
    let mut raw = String::new();
    ch.read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let _ = ch.close();

    let mut d = IfaceDetails {
        name: iface.to_string(),
        mac: None, mtu: None, operstate: None, speed_mbps: None,
        ipv4: vec![], ipv6: vec![],
        rx_bytes: 0, tx_bytes: 0, rx_packets: 0, tx_packets: 0,
        rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0,
        driver: None, bus_info: None,
    };

    for line in raw.lines() {
        if let Some((k, v)) = line.split_once('=') {
            let v = v.trim();
            match k {
                "MAC"      => d.mac       = if v.is_empty() { None } else { Some(v.to_string()) },
                "MTU"      => d.mtu       = v.parse().ok(),
                "STATE"    => d.operstate = if v.is_empty() { None } else { Some(v.to_string()) },
                "SPEED"    => d.speed_mbps = {
                    let n = parse_i64(v);
                    if n <= 0 { Some(-1) } else { Some(n) }
                },
                "RX_BYTES"  => d.rx_bytes   = parse_u64(v),
                "TX_BYTES"  => d.tx_bytes   = parse_u64(v),
                "RX_PKTS"   => d.rx_packets = parse_u64(v),
                "TX_PKTS"   => d.tx_packets = parse_u64(v),
                "RX_ERR"    => d.rx_errors  = parse_u64(v),
                "TX_ERR"    => d.tx_errors  = parse_u64(v),
                "RX_DROP"   => d.rx_dropped = parse_u64(v),
                "TX_DROP"   => d.tx_dropped = parse_u64(v),
                "IPV4"     => { if !v.is_empty() { d.ipv4.push(v.to_string()); } },
                "IPV6"     => { if !v.is_empty() { d.ipv6.push(v.to_string()); } },
                "DRIVER"   => d.driver   = if v.is_empty() { None } else { Some(v.to_string()) },
                "BUS"      => d.bus_info = if v.is_empty() { None } else { Some(v.to_string()) },
                _ => {}
            }
        }
    }
    Ok(d)
}

#[tauri::command]
pub async fn get_iface_details(
    state: tauri::State<'_, SshState>,
    session_id: String,
    iface: String,
) -> Result<IfaceDetails, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        collect_iface_details(&session, &iface)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Speedtest (runs on the remote device via SSH) ─────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpeedtestResult {
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub latency_ms:  f64,
    pub jitter_ms:   f64,
    pub server:      String,
    pub error:       Option<String>,
}

fn run_speedtest_ssh(session: &Session) -> SpeedtestResult {
    // NOTE: the caller holds the sftp_session Mutex for the duration of this
    // function (~45 s). This is intentional — libssh2 sessions are not
    // thread-safe, so the Mutex serialises all access. During a speedtest,
    // get_metrics calls will queue behind it. Each phase below opens/closes
    // its own SSH channel, but that does NOT release the Mutex.
    fn phase(session: &Session, cmd: &str) -> Result<String, String> {
        let mut ch = session.channel_session().map_err(|e| format!("channel: {}", e))?;
        ch.exec(cmd).map_err(|e| format!("exec: {}", e))?;
        let mut out = String::new();
        ch.read_to_string(&mut out).map_err(|e| e.to_string())?;
        let _ = ch.close();
        Ok(out)
    }

    // Phase 1: latency — 5 tiny HTTP round-trips on one channel
    let lat_script = r#"for i in 1 2 3 4 5; do curl -s -o /dev/null -w "%{time_total}\n" --max-time 3 "https://speed.cloudflare.com/__down?measId=0&bytes=0" 2>/dev/null || echo "0"; done"#;
    let lat_raw = match phase(session, lat_script) {
        Err(e) => return SpeedtestResult {
            download_mbps: 0.0, upload_mbps: 0.0, latency_ms: 0.0,
            jitter_ms: 0.0, server: String::new(),
            error: Some(format!("curl unavailable or no internet on remote device: {}", e)),
        },
        Ok(s) => s,
    };

    let times: Vec<f64> = lat_raw.lines()
        .filter_map(|l| l.trim().parse::<f64>().ok())
        .filter(|&t| t > 0.0)
        .collect();

    if times.is_empty() {
        return SpeedtestResult {
            download_mbps: 0.0, upload_mbps: 0.0, latency_ms: 0.0,
            jitter_ms: 0.0, server: String::new(),
            error: Some("curl not available or no internet access on the remote device".to_string()),
        };
    }

    let latency_ms = times.iter().sum::<f64>() / times.len() as f64 * 1000.0;
    let jitter_ms = if times.len() > 1 {
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        let var  = times.iter().map(|t| (t - mean).powi(2)).sum::<f64>() / times.len() as f64;
        var.sqrt() * 1000.0
    } else { 0.0 };

    // Phase 2: download 10 MB — own channel, mutex released between phases
    let dl_bps: f64 = phase(
        session,
        r#"curl -s -o /dev/null -w "%{speed_download}" --max-time 15 "https://speed.cloudflare.com/__down?measId=0&bytes=10000000" 2>/dev/null || echo "0""#,
    ).unwrap_or_default().trim().parse().unwrap_or(0.0);

    // Phase 3: upload 2 MB — own channel
    let ul_bps: f64 = phase(
        session,
        r#"dd if=/dev/zero bs=1M count=2 2>/dev/null | curl -s -X POST --data-binary @- -o /dev/null -w "%{speed_upload}" --max-time 15 "https://speed.cloudflare.com/__up?measId=0" 2>/dev/null || echo "0""#,
    ).unwrap_or_default().trim().parse().unwrap_or(0.0);

    SpeedtestResult {
        download_mbps: dl_bps / 1_000_000.0 * 8.0,
        upload_mbps:   ul_bps / 1_000_000.0 * 8.0,
        latency_ms,
        jitter_ms,
        server: "speed.cloudflare.com".to_string(),
        error: None,
    }
}

#[tauri::command]
pub async fn run_speedtest(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<SpeedtestResult, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        // The Mutex is held for the full ~45 s duration. libssh2 is not
        // thread-safe, so this serialises all session access correctly.
        // get_metrics calls will block until the speedtest completes.
        let session_guard = conn.sftp_session.lock()
            .unwrap_or_else(|e| e.into_inner());
        let result = run_speedtest_ssh(&session_guard);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
