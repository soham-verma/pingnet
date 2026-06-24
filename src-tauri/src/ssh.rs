use serde::{Deserialize, Serialize};
use ssh2::{Channel, Session};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

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
    Key { key_path: String, passphrase: Option<String> },
}

enum ShellMsg {
    Input(String),
    Resize(u32, u32),
    Stop,
}

pub struct SshConnection {
    pub shell_tx: mpsc::SyncSender<ShellMsg>,
    /// Separate session kept for SFTP — accessed only inside spawn_blocking
    pub sftp_session: Mutex<Session>,
    pub stop_flag: Arc<AtomicBool>,
    pub host: String,
    pub port: u16,
    pub username: String,
    // kept to recreate sftp session if needed
    auth: SshAuth,
}

pub struct SshState {
    pub sessions: tokio::sync::Mutex<HashMap<String, Arc<SshConnection>>>,
}

impl SshState {
    pub fn new() -> Self {
        Self { sessions: tokio::sync::Mutex::new(HashMap::new()) }
    }
}

// ── Known-hosts TOFU store ────────────────────────────────────────────────────

fn known_hosts_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("known_hosts.json"))
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
            return Err(format!(
                "HOST_KEY_CHANGED\nThe host key for {} has changed!\n\
                 Stored:  {}\nCurrent: {}\n\n\
                 This could indicate a man-in-the-middle attack or the server was reinstalled. \
                 If you trust this change, remove the entry from known_hosts.json in the Pingnet app data directory.",
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

// ── Connection helpers ────────────────────────────────────────────────────────

fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    TcpStream::connect(format!("{}:{}", host, port))
        .map_err(|e| format!("TCP connect failed: {}", e))
}

fn make_session(stream: TcpStream, host: &str, port: u16, app: &tauri::AppHandle) -> Result<Session, String> {
    let mut session = Session::new().map_err(|e| format!("Session init failed: {}", e))?;
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
            let passphrase = passphrase.as_deref();
            session
                .userauth_pubkey_file(username, None, Path::new(key_path), passphrase)
                .map_err(|e| format!("Key auth failed: {}", e))?;
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
        host,
        port,
        username,
        auth,
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

        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let local_path = format!("{}/Downloads/{}", home, filename);

        let mut remote_file = sftp.open(Path::new(&remote_path)).map_err(|e| e.to_string())?;
        let mut local_file = std::fs::File::create(&local_path).map_err(|e| e.to_string())?;

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

#[tauri::command]
pub async fn sftp_upload(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), String> {
    // Guard against path traversal from a compromised webview
    if local_path.contains("..") {
        return Err("Path traversal not permitted".to_string());
    }

    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap();
        let sftp = session.sftp().map_err(|e| e.to_string())?;

        let filename = Path::new(&local_path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let total_bytes = std::fs::metadata(&local_path)
            .map(|m| m.len())
            .unwrap_or(0);

        let mut local_file = std::fs::File::open(&local_path)
            .map_err(|e| format!("Cannot open local file: {}", e))?;
        let mut remote_file = sftp
            .create(Path::new(&remote_path))
            .map_err(|e| format!("Cannot create remote file: {}", e))?;

        let mut buf = [0u8; 65536];
        let mut bytes_done = 0u64;

        loop {
            match local_file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    remote_file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    bytes_done += n as u64;
                    app.emit("transfer-progress", TransferProgress {
                        id: transfer_id.clone(),
                        name: filename.clone(),
                        kind: "upload".to_string(),
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
            kind: "upload".to_string(),
            bytes_done,
            total_bytes,
            status: "done".to_string(),
            error: None,
        }).ok();

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

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
