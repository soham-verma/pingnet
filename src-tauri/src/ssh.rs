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
    /// Keyboard-interactive auth — responds with a TOTP code to every server prompt.
    /// Used for Google Authenticator / any TOTP-based two-factor SSH auth.
    KbdInt {
        totp_code: String,
        /// Answer for "Password:" prompts when the server asks for password + code
        #[serde(default)]
        password: Option<String>,
    },
}

enum ShellMsg {
    Input(String),
    Resize(u32, u32),
    Stop,
}

pub struct SshConnection {
    shell_tx: mpsc::SyncSender<ShellMsg>,
    /// Session for SFTP / exec / tunnels — accessed only inside spawn_blocking.
    /// Normally a second authenticated connection; for one-time-code auth that
    /// forbids code reuse it is the SAME session as the shell (shared mode).
    /// pub(crate) so docker.rs and other modules can lock it for SSH exec calls.
    pub(crate) sftp_session: Arc<Mutex<Session>>,
    stop_flag: Arc<AtomicBool>,
}

pub struct SshState {
    pub sessions: tokio::sync::Mutex<HashMap<String, Arc<SshConnection>>>,
    pub metrics:  std::sync::Arc<crate::metrics::MetricsState>,
    /// Connections still being set up — ssh_disconnect flips the flag so the
    /// setup aborts and tears down instead of registering (audit BUG-006).
    pending: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SshState {
    pub fn new() -> Self {
        Self {
            sessions: tokio::sync::Mutex::new(HashMap::new()),
            metrics:  crate::metrics::MetricsState::new(),
            pending:  Mutex::new(HashMap::new()),
        }
    }
}

// ── Known-hosts store ─────────────────────────────────────────────────────────
//
// Fails CLOSED (audit SEC-004): a known_hosts.json that exists but can't be
// read or parsed refuses connections instead of silently becoming an empty
// store that would accept any key. Writes are atomic (tmp + rename) and every
// load-modify-save runs under one process-wide lock so concurrent tabs can't
// lose updates. New hosts are NOT auto-trusted: the user confirms the SHA256
// fingerprint first, and "trust" can only pin the key the server actually
// presented (kept in PENDING_KEYS), never an arbitrary string from the webview.

static KNOWN_HOSTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static PENDING_KEYS: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn known_hosts_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir()
        .map(|d: PathBuf| d.join("known_hosts.json"))
        .map_err(|e| format!("Cannot resolve app data dir: {}", e))
}

fn load_known_hosts_at(path: &Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("{} is corrupt ({}). Fix or remove it to re-verify your hosts.", path.display(), e))
}

fn save_known_hosts_at(path: &Path, map: &HashMap<String, String>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Cannot write host keys: {}", e))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Cannot save host keys: {}", e))
}

/// Compute a collision-resistant fingerprint from the raw host key bytes.
/// Format: "<key-type>:<hex-bytes>" — e.g. "ssh-ed25519:aabbcc..."
fn raw_key_fingerprint(session: &Session) -> Option<String> {
    let (key_bytes, key_type) = session.host_key()?;
    // ssh2 0.9.x HostKeyType: Rsa | Dss | Ed25519 | Unknown
    // ECDSA keys are reported as Unknown in this version (no separate variant).
    let type_str = match key_type {
        ssh2::HostKeyType::Rsa     => "ssh-rsa",
        ssh2::HostKeyType::Dss     => "ssh-dss",
        ssh2::HostKeyType::Ed25519 => "ssh-ed25519",
        _                          => "unknown",
    };
    let hex = key_bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>();
    Some(format!("{}:{}", type_str, hex))
}

/// OpenSSH-style "SHA256:<base64>" for a stored "<type>:<hex>" fingerprint —
/// the same string `ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub` prints on the
/// server, so the user can verify it out-of-band.
pub(crate) fn sha256_display(raw: &str) -> Option<String> {
    use base64::Engine;
    use sha2::Digest;
    let hex = raw.split_once(':').map(|(_, h)| h).unwrap_or(raw);
    if hex.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len()).step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect();
    let digest = sha2::Sha256::digest(bytes?);
    Some(format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)))
}

/// Decide what to do with a presented key. Pure so it can be unit-tested.
#[derive(Debug, PartialEq)]
enum HostKeyVerdict { Trusted, Unknown, Changed(String) }

fn judge_host_key(known: &HashMap<String, String>, host_key: &str, fingerprint: &str) -> HostKeyVerdict {
    match known.get(host_key) {
        Some(stored) if stored == fingerprint => HostKeyVerdict::Trusted,
        Some(stored) => HostKeyVerdict::Changed(stored.clone()),
        None => HostKeyVerdict::Unknown,
    }
}

fn verify_host_key(session: &Session, host: &str, port: u16, app: &tauri::AppHandle) -> Result<(), String> {
    let fingerprint = raw_key_fingerprint(session)
        .ok_or_else(|| "Server provided no host key — refusing connection".to_string())?;
    let host_key = format!("[{}]:{}", host, port);
    let path = known_hosts_path(app)?;

    let known = {
        let _g = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load_known_hosts_at(&path).map_err(|e| format!("HOST_KEY_STORE_ERROR\x00detail={}", e))?
    };
    let key_type = fingerprint.split(':').next().unwrap_or("").to_string();
    let sha = sha256_display(&fingerprint).unwrap_or_default();

    match judge_host_key(&known, &host_key, &fingerprint) {
        HostKeyVerdict::Trusted => Ok(()),
        HostKeyVerdict::Unknown => {
            PENDING_KEYS.lock().unwrap_or_else(|e| e.into_inner()).insert(host_key, fingerprint.clone());
            Err(format!(
                "HOST_KEY_UNKNOWN\x00host={}\x00current={}\x00current_sha256={}\x00keytype={}",
                host, fingerprint, sha, key_type
            ))
        }
        HostKeyVerdict::Changed(stored) => {
            PENDING_KEYS.lock().unwrap_or_else(|e| e.into_inner()).insert(host_key, fingerprint.clone());
            Err(format!(
                "HOST_KEY_CHANGED\x00host={}\x00stored={}\x00current={}\x00stored_sha256={}\x00current_sha256={}",
                host, stored, fingerprint, sha256_display(&stored).unwrap_or_default(), sha
            ))
        }
    }
}

/// Remove a host's stored key so the next connection asks again.
#[tauri::command]
pub async fn clear_host_key(
    app: tauri::AppHandle,
    host: String,
    port: u16,
) -> Result<(), String> {
    let path = known_hosts_path(&app)?;
    let _g = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut known = load_known_hosts_at(&path)?;
    known.remove(&format!("[{}]:{}", host, port));
    save_known_hosts_at(&path, &known)
}

/// Pin the key this host presented on its last (rejected) connection attempt.
/// `fingerprint` must match what the server actually sent — the backend never
/// trusts a value the webview made up.
#[tauri::command]
pub async fn trust_host_key(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    fingerprint: String,
) -> Result<(), String> {
    let host_key = format!("[{}]:{}", host, port);
    let pending = PENDING_KEYS.lock().unwrap_or_else(|e| e.into_inner()).get(&host_key).cloned();
    match pending {
        Some(p) if p == fingerprint => {}
        _ => return Err("That key wasn't presented by this host — reconnect and verify again".to_string()),
    }
    let path = known_hosts_path(&app)?;
    let _g = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut known = load_known_hosts_at(&path)?;
    known.insert(host_key.clone(), fingerprint);
    save_known_hosts_at(&path, &known)?;
    PENDING_KEYS.lock().unwrap_or_else(|e| e.into_inner()).remove(&host_key);
    Ok(())
}

#[cfg(test)]
mod kbd_tests {
    #[test]
    fn prompts_get_the_right_answer() {
        assert_eq!(super::kbd_answer("Password: ", "123456", Some("pw")), "pw");
        assert_eq!(super::kbd_answer("Verification code: ", "123456", Some("pw")), "123456");
        assert_eq!(super::kbd_answer("One-time password (OTP): ", "123456", Some("pw")), "123456");
        // no password supplied → code for everything (previous behaviour)
        assert_eq!(super::kbd_answer("Password: ", "123456", None), "123456");
    }
}

#[cfg(test)]
mod known_hosts_tests {
    use super::*;

    fn tmpfile(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pn-kh-{}-{:?}", name, std::time::Instant::now()));
        std::fs::create_dir_all(&d).unwrap();
        d.join("known_hosts.json")
    }

    #[test]
    fn missing_store_is_empty() {
        assert!(load_known_hosts_at(&tmpfile("missing")).unwrap().is_empty());
    }

    #[test]
    fn corrupt_store_fails_closed() {
        let p = tmpfile("corrupt");
        std::fs::write(&p, "{not json").unwrap();
        assert!(load_known_hosts_at(&p).is_err());
    }

    #[test]
    fn roundtrip_is_atomic_and_readable() {
        let p = tmpfile("rt");
        let mut m = HashMap::new();
        m.insert("[h]:22".to_string(), "ssh-ed25519:ab".to_string());
        save_known_hosts_at(&p, &m).unwrap();
        assert_eq!(load_known_hosts_at(&p).unwrap(), m);
        assert!(!p.with_extension("json.tmp").exists());
    }

    #[test]
    fn verdicts() {
        let mut m = HashMap::new();
        m.insert("[h]:22".to_string(), "ssh-ed25519:aa".to_string());
        assert_eq!(judge_host_key(&m, "[h]:22", "ssh-ed25519:aa"), HostKeyVerdict::Trusted);
        assert_eq!(judge_host_key(&m, "[h]:22", "ssh-ed25519:bb"), HostKeyVerdict::Changed("ssh-ed25519:aa".into()));
        assert_eq!(judge_host_key(&m, "[x]:22", "ssh-ed25519:aa"), HostKeyVerdict::Unknown);
    }

    #[test]
    fn sha256_matches_openssh_format() {
        // key blob bytes "abc" → SHA256 base64 (no padding)
        assert_eq!(sha256_display("ssh-ed25519:616263").unwrap(), "SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0");
        assert!(sha256_display("ssh-ed25519:abc").is_none());
    }
}

// ── Connection helpers ────────────────────────────────────────────────────────

// Deadlines (audit BUG-015). libssh2's session timeout bounds every blocking
// call; keepalives detect peers that silently vanish.
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SETUP_TIMEOUT_MS: u32 = 20_000;   // handshake, auth, channel setup, shell writes
const AUX_TIMEOUT_MS: u32 = 120_000;    // any single blocking call on the aux session
const KEEPALIVE_SECS: u32 = 15;

fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    use std::net::ToSocketAddrs;
    let addrs: Vec<std::net::SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("DNS lookup failed: {}", e))?
        .collect();
    let mut last_err = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, TCP_CONNECT_TIMEOUT) {
            Ok(s) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(format!(
        "TCP connect failed: {}",
        last_err.map(|e| e.to_string()).unwrap_or_else(|| "no addresses".to_string())
    ))
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
    session.set_timeout(SETUP_TIMEOUT_MS);
    session.set_keepalive(true, KEEPALIVE_SECS);
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
        SshAuth::KbdInt { totp_code, password } => {
            // Keyboard-interactive: answer each prompt by what it asks for —
            // password prompts get the password (when given), code prompts get
            // the one-time code (audit BUG-012: previously every prompt got the code).
            struct KbdResponder { code: String, password: Option<String> }
            impl ssh2::KeyboardInteractivePrompt for KbdResponder {
                fn prompt(
                    &mut self,
                    _username: &str,
                    _instructions: &str,
                    prompts: &[ssh2::Prompt<'_>],
                ) -> Vec<String> {
                    prompts.iter().map(|p| kbd_answer(&p.text, &self.code, self.password.as_deref())).collect()
                }
            }
            session
                .userauth_keyboard_interactive(username, &mut KbdResponder {
                    code: totp_code.clone(),
                    password: password.clone(),
                })
                .map_err(|e| format!("TOTP/keyboard-interactive auth failed: {}", e))?;
        }
    }
    if !session.authenticated() {
        return Err("Authentication rejected by server".to_string());
    }
    Ok(())
}

/// Pick the answer for one keyboard-interactive prompt.
fn kbd_answer(prompt: &str, code: &str, password: Option<&str>) -> String {
    let p = prompt.to_lowercase();
    let wants_code = ["verification", "code", "otp", "token", "authenticator", "one-time", "2fa", "passcode"]
        .iter().any(|k| p.contains(k));
    match password {
        Some(pw) if !wants_code && p.contains("password") => pw.to_string(),
        _ => code.to_string(),
    }
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

/// The shell's session: its own connection (normal), or shared with the aux
/// operations under their mutex (one-time-code auth fallback).
enum ShellSession {
    Owned(Session),
    Shared(Arc<Mutex<Session>>),
}

impl ShellSession {
    fn with<R>(&self, f: impl FnOnce(&Session) -> R) -> R {
        match self {
            ShellSession::Owned(s) => f(s),
            ShellSession::Shared(m) => {
                let s = m.lock().unwrap_or_else(|e| e.into_inner());
                f(&s)
            }
        }
    }
}

fn run_shell_thread(
    session: ShellSession,
    mut channel: Channel,
    rx: mpsc::Receiver<ShellMsg>,
    app: tauri::AppHandle,
    session_id: String,
    stop_flag: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 8192];
    let mut pending_utf8: Vec<u8> = Vec::new();
    let mut last_keepalive = std::time::Instant::now();

    'outer: loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        // One locked step: non-blocking read + drain queued input. In shared
        // mode the session is restored to blocking before the lock is released
        // because aux operations expect blocking I/O.
        let step: Result<(Option<Vec<u8>>, bool), ()> = session.with(|s| {
            s.set_blocking(false);
            let mut out = None;
            let mut eof = false;
            let r = match channel.read(&mut buf) {
                Ok(0) => { eof = channel.eof(); Ok(()) }
                Ok(n) => { out = Some(buf[..n].to_vec()); Ok(()) }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(()),
                Err(_) => Err(()),
            };
            s.set_blocking(true);
            r.map(|_| (out, eof))
        });
        let (data, eof) = match step {
            Ok(v) => v,
            Err(()) => break,
        };
        if let Some(bytes) = data {
            pending_utf8.extend_from_slice(&bytes);
            let text = crate::utf8_stream::take_utf8(&mut pending_utf8);
            if !text.is_empty() {
                app.emit(&format!("ssh-output-{}", session_id), text).ok();
            }
        }
        if eof {
            break;
        }

        // Drain pending commands
        while let Ok(msg) = rx.try_recv() {
            match msg {
                ShellMsg::Input(data) => {
                    let ok = session.with(|_s| {
                        channel.write_all(data.as_bytes()).and_then(|_| channel.flush()).is_ok()
                    });
                    if !ok {
                        break 'outer;
                    }
                }
                ShellMsg::Resize(cols, rows) => {
                    session.with(|_s| { let _ = channel.request_pty_size(cols, rows, None, None); });
                }
                ShellMsg::Stop => {
                    stop_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }

        // Keepalive: detects a silently-dead peer instead of hanging forever
        if last_keepalive.elapsed() >= Duration::from_secs(KEEPALIVE_SECS as u64) {
            last_keepalive = std::time::Instant::now();
            if session.with(|s| s.keepalive_send()).is_err() {
                break;
            }
        }

        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        std::thread::sleep(Duration::from_millis(8));
    }

    session.with(|_s| { let _ = channel.close(); });
    if let ShellSession::Owned(s) = &session {
        let _ = s.disconnect(None, "closed", None);
    }
    app.emit(&format!("ssh-closed-{}", session_id), ()).ok();
}

/// Connect + handshake + host-key check + authenticate one session.
/// Err carries (message, was_auth_rejection).
fn open_authed_session(
    host: &str, port: u16, username: &str, auth: &SshAuth, app: &tauri::AppHandle,
) -> Result<Session, (String, bool)> {
    let stream = tcp_connect(host, port).map_err(|e| (e, false))?;
    let session = make_session(stream, host, port, app).map_err(|e| (e, false))?;
    auth_session(&session, username, auth).map_err(|e| (e, true))?;
    Ok(session)
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
    // Disconnect any existing session with this id first
    if let Some(old) = state.sessions.lock().await.remove(&session_id) {
        old.stop_flag.store(true, Ordering::Relaxed);
        let _ = old.shell_tx.try_send(ShellMsg::Stop);
    }

    // Register as pending so a disconnect during setup cancels it
    let cancel = Arc::new(AtomicBool::new(false));
    state.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(session_id.clone(), cancel.clone());

    // Build EVERYTHING before starting threads or registering: any failure or
    // cancellation just drops the sessions, closing both connections — no
    // orphaned shell threads or half-registered sessions (audit BUG-006).
    let setup = tauri::async_runtime::spawn_blocking({
        let (host, username, auth, app, cancel) = (host.clone(), username.clone(), auth.clone(), app.clone(), cancel.clone());
        move || -> Result<(Session, Channel, Option<Session>), String> {
            let check = || if cancel.load(Ordering::Relaxed) { Err("Connection cancelled".to_string()) } else { Ok(()) };

            let shell_sess = open_authed_session(&host, port, &username, &auth, &app).map_err(|(e, _)| e)?;
            check()?;
            let channel = open_shell(&shell_sess)?;
            check()?;

            let aux = match open_authed_session(&host, port, &username, &auth, &app) {
                Ok(s) => Some(s),
                // One-time codes are often single-use: the second login with the
                // same code is rejected. Fall back to sharing the shell's session.
                Err((_, true)) if matches!(auth, SshAuth::KbdInt { .. }) => None,
                Err((e, _)) => return Err(e),
            };
            check()?;
            if let Some(a) = &aux {
                a.set_timeout(AUX_TIMEOUT_MS);
            }
            Ok((shell_sess, channel, aux))
        }
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);

    state.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&session_id);
    let (shell_sess, channel, aux) = setup?;
    if cancel.load(Ordering::Relaxed) {
        return Err("Connection cancelled".to_string());
    }

    let (shell_tx, shell_rx) = mpsc::sync_channel::<ShellMsg>(256);
    let stop_flag = Arc::new(AtomicBool::new(false));

    let (shell_session, aux_arc) = match aux {
        Some(aux) => (ShellSession::Owned(shell_sess), Arc::new(Mutex::new(aux))),
        None => {
            shell_sess.set_timeout(AUX_TIMEOUT_MS);
            let shared = Arc::new(Mutex::new(shell_sess));
            (ShellSession::Shared(shared.clone()), shared)
        }
    };

    let conn = Arc::new(SshConnection {
        shell_tx,
        sftp_session: aux_arc,
        stop_flag: stop_flag.clone(),
    });
    state.sessions.lock().await.insert(session_id.clone(), conn);

    let (app_t, sid_t) = (app.clone(), session_id.clone());
    std::thread::spawn(move || run_shell_thread(shell_session, channel, shell_rx, app_t, sid_t, stop_flag));
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: tauri::State<'_, SshState>,
    session_id: String,
) -> Result<(), String> {
    // Cancel a connection that is still being set up
    if let Some(flag) = state.pending.lock().unwrap_or_else(|e| e.into_inner()).get(&session_id) {
        flag.store(true, Ordering::Relaxed);
    }
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

fn strip_sudo_prompt(s: &str) -> String {
    s.lines()
        .filter(|line| !line.trim_start().starts_with("[sudo] password for"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Run a non-interactive command on the remote host via the existing SFTP session
/// (a separate authenticated SSH connection), collect all stdout + stderr, and
/// return the combined output as a String.  Used by the Partition Manager.
#[tauri::command]
pub async fn ssh_exec(
    state: tauri::State<'_, SshState>,
    session_id: String,
    command: String,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let sessions = state.sessions.lock().await;
    let conn = sessions
        .get(&session_id)
        .ok_or("SSH session not found")?
        .clone();
    drop(sessions); // release the lock before spawn_blocking

    // Password goes to sudo's stdin, never into the command line (SEC-002)
    let rc = crate::remote::sudo_cmd(&command, &sudo_password);

    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
        // Merged stdout+stderr: callers show combined output, and it can't
        // deadlock on a full stderr window.
        let (combined, _, exit) = crate::remote::run(&session, &rc, true)?;
        let cleaned = strip_sudo_prompt(&combined);
        if exit != 0 {
            return Err(if cleaned.trim().is_empty() {
                format!("Command failed (exit status {})", exit)
            } else {
                cleaned.trim().to_string()
            });
        }
        Ok(cleaned)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── SFTP helpers ──────────────────────────────────────────────────────────────

fn format_permissions(mode: u32) -> String {
    let types = [("r", 0o400), ("w", 0o200), ("x", 0o100),
                 ("r", 0o040), ("w", 0o020), ("x", 0o010),
                 ("r", 0o004), ("w", 0o002), ("x", 0o001)];
    types.iter().map(|(c, m)| if mode & m != 0 { c } else { "-" }).collect()
}

pub(crate) fn get_conn(
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
    let display_name = Path::new(&remote_path)
        .file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let result = sftp_download_inner(app.clone(), &state, session_id, remote_path, transfer_id.clone()).await;
    if let Err(e) = &result {
        // Every transfer must end in done/error — never leave it "running"
        emit_transfer_error(&app, &transfer_id, &display_name, "download", e);
    }
    result
}

fn emit_transfer_error(app: &tauri::AppHandle, id: &str, name: &str, kind: &str, err: &str) {
    app.emit("transfer-progress", TransferProgress {
        id: id.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        bytes_done: 0,
        total_bytes: 0,
        status: "error".to_string(),
        error: Some(err.to_string()),
    }).ok();
}

async fn sftp_download_inner(
    app: tauri::AppHandle,
    state: &tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
    transfer_id: String,
) -> Result<String, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
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
// ── Chunked, crash-safe upload ──────────────────────────────────────────────
//
// Data is streamed in binary chunks (raw IPC body, no JSON number arrays) into
// a hidden temp file next to the destination. Only once every byte is written
// and the size verified is the temp file moved over the destination; an
// existing destination is first moved aside and restored if the swap fails.
// An interrupted upload therefore never damages the original file.

fn validate_transfer_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid transfer id".to_string());
    }
    Ok(())
}

/// `<dir>/.<name>.pingnet-<id>.<ext>` beside the destination.
fn upload_side_path(remote_path: &str, transfer_id: &str, ext: &str) -> Result<PathBuf, String> {
    validate_transfer_id(transfer_id)?;
    let p = Path::new(remote_path);
    let name = p.file_name().ok_or("Invalid remote path")?.to_string_lossy().to_string();
    let parent = p.parent().unwrap_or_else(|| Path::new("/"));
    Ok(parent.join(format!(".{}.pingnet-{}.{}", name, transfer_id, ext)))
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or("Bad percent-encoding")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "Bad percent-encoding")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Header is not UTF-8".to_string())
}

fn req_header(req: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = req.headers().get(name)
        .ok_or_else(|| format!("Missing header {}", name))?
        .to_str().map_err(|_| format!("Bad header {}", name))?;
    percent_decode(raw)
}

/// Does a remote path exist? Used to confirm overwrites before uploading.
#[tauri::command]
pub async fn sftp_path_exists(
    state: tauri::State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<bool, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        Ok(sftp.stat(Path::new(&path)).is_ok())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write one chunk (raw request body) at `x-offset` into the upload's temp file.
/// Headers (percent-encoded): x-session-id, x-transfer-id, x-remote-path,
/// x-name, x-offset, x-total.
#[tauri::command]
pub async fn sftp_upload_chunk(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("sftp_upload_chunk expects a binary body".to_string()),
    };
    let session_id = req_header(&request, "x-session-id")?;
    let transfer_id = req_header(&request, "x-transfer-id")?;
    let remote_path = req_header(&request, "x-remote-path")?;
    let name = req_header(&request, "x-name")?;
    let offset: u64 = req_header(&request, "x-offset")?.parse().map_err(|_| "Bad x-offset")?;
    let total: u64 = req_header(&request, "x-total")?.parse().map_err(|_| "Bad x-total")?;
    let tmp = upload_side_path(&remote_path, &transfer_id, "part")?;

    let result: Result<(), String> = async {
        let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
        let app_c = app.clone();
        let (tid, nm) = (transfer_id.clone(), name.clone());
        tauri::async_runtime::spawn_blocking(move || {
            use std::io::{Seek, SeekFrom};
            let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
            let sftp = session.sftp().map_err(|e| e.to_string())?;
            let mut f = if offset == 0 {
                sftp.create(&tmp).map_err(|e| format!("Cannot create temp file: {}", e))?
            } else {
                sftp.open_mode(&tmp, ssh2::OpenFlags::WRITE, 0o600, ssh2::OpenType::File)
                    .map_err(|e| format!("Cannot reopen temp file: {}", e))?
            };
            f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            f.write_all(&bytes).map_err(|e| e.to_string())?;
            app_c.emit("transfer-progress", TransferProgress {
                id: tid, name: nm, kind: "upload".to_string(),
                bytes_done: offset + bytes.len() as u64, total_bytes: total,
                status: "running".to_string(), error: None,
            }).ok();
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }.await;

    if let Err(e) = &result {
        emit_transfer_error(&app, &transfer_id, &name, "upload", e);
        let _ = sftp_upload_abort(state, session_id, remote_path, transfer_id).await;
    }
    result
}

/// Verify the temp file and atomically-as-possible move it over the destination.
#[tauri::command]
pub async fn sftp_upload_commit(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
    transfer_id: String,
    name: String,
    total_bytes: u64,
) -> Result<(), String> {
    let tmp = upload_side_path(&remote_path, &transfer_id, "part")?;
    let bak = upload_side_path(&remote_path, &transfer_id, "bak")?;
    let result: Result<(), String> = async {
        let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
        let dst = PathBuf::from(&remote_path);
        tauri::async_runtime::spawn_blocking(move || {
            let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
            let sftp = session.sftp().map_err(|e| e.to_string())?;

            let written = sftp.stat(&tmp).map_err(|e| format!("Temp file missing: {}", e))?.size.unwrap_or(0);
            if written != total_bytes {
                let _ = sftp.unlink(&tmp);
                return Err(format!("Upload incomplete ({} of {} bytes) — destination left untouched", written, total_bytes));
            }

            match sftp.stat(&dst) {
                Ok(existing) => {
                    if existing.is_dir() {
                        let _ = sftp.unlink(&tmp);
                        return Err("Destination is a directory".to_string());
                    }
                    // Keep the original's permissions on the replacement
                    if existing.perm.is_some() {
                        let _ = sftp.setstat(&tmp, ssh2::FileStat {
                            size: None, uid: None, gid: None, perm: existing.perm, atime: None, mtime: None,
                        });
                    }
                    sftp.rename(&dst, &bak, None).map_err(|e| format!("Cannot move original aside: {}", e))?;
                    if let Err(e) = sftp.rename(&tmp, &dst, None) {
                        // Put the original back — never leave the destination missing
                        let restored = sftp.rename(&bak, &dst, None).is_ok();
                        let _ = sftp.unlink(&tmp);
                        return Err(format!(
                            "Cannot replace file: {}{}",
                            e,
                            if restored { " — original restored" } else { " — original kept at the .bak path" }
                        ));
                    }
                    let _ = sftp.unlink(&bak);
                }
                Err(_) => {
                    sftp.rename(&tmp, &dst, None).map_err(|e| {
                        let _ = sftp.unlink(&tmp);
                        format!("Cannot move upload into place: {}", e)
                    })?;
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }.await;

    match &result {
        Ok(()) => {
            app.emit("transfer-progress", TransferProgress {
                id: transfer_id, name, kind: "upload".to_string(),
                bytes_done: total_bytes, total_bytes, status: "done".to_string(), error: None,
            }).ok();
        }
        Err(e) => emit_transfer_error(&app, &transfer_id, &name, "upload", e),
    }
    result
}

/// Remove an upload's temp file (cancel / failure cleanup). Best-effort.
#[tauri::command]
pub async fn sftp_upload_abort(
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let tmp = upload_side_path(&remote_path, &transfer_id, "part")?;
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(sftp) = session.sftp() {
            let _ = sftp.unlink(&tmp);
        }
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
        // Same lock order as get_metrics: session first, caps only briefly.
        let session = conn.sftp_session.lock().unwrap_or_else(|e| e.into_inner());
        Ok(crate::metrics::cached_or_probe(&session, &session_id, &metrics_arc))
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
//
// Core logic (Cloudflare download/upload/latency, connectivity check,
// interface binding) lives in crate::speedtest — shared with the local
// (non-SSH) variant. This just supplies an SSH-channel-backed `exec`.

pub use crate::speedtest::SpeedtestResult;

fn run_speedtest_ssh(session: &Session, iface: Option<&str>, force: bool) -> SpeedtestResult {
    // NOTE: the caller holds the sftp_session Mutex for the duration of this
    // function (~45 s). This is intentional — libssh2 sessions are not
    // thread-safe, so the Mutex serialises all access. During a speedtest,
    // get_metrics calls will queue behind it. Each phase below opens/closes
    // its own SSH channel, but that does NOT release the Mutex.
    let exec = |cmd: &str| -> Result<String, String> {
        let mut ch = session.channel_session().map_err(|e| format!("channel: {}", e))?;
        ch.exec(cmd).map_err(|e| format!("exec: {}", e))?;
        let mut out = String::new();
        ch.read_to_string(&mut out).map_err(|e| e.to_string())?;
        let _ = ch.close();
        Ok(out)
    };
    crate::speedtest::run_core(&exec, iface, force)
}

#[tauri::command]
pub async fn run_speedtest(
    state: tauri::State<'_, SshState>,
    session_id: String,
    iface: Option<String>,
    force: bool,
) -> Result<SpeedtestResult, String> {
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        // The Mutex is held for the full ~45 s duration. libssh2 is not
        // thread-safe, so this serialises all session access correctly.
        // get_metrics calls will block until the speedtest completes.
        let session_guard = conn.sftp_session.lock()
            .unwrap_or_else(|e| e.into_inner());
        let result = run_speedtest_ssh(&session_guard, iface.as_deref(), force);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── HTTP over SSH tunnel ──────────────────────────────────────────────────────
//
// Opens a direct-tcpip channel through the existing sftp_session to any host:port
// reachable from inside the remote machine, sends a raw HTTP/1.1 request, and
// returns the parsed response. No port is opened on the local machine.

#[tauri::command]
pub async fn tunnel_http_request(
    state: tauri::State<'_, SshState>,
    session_id: String,
    remote_host: String,
    remote_port: u16,
    method: String,
    path: String,
    headers: Vec<crate::http_client::HttpHeader>,
    body: Option<String>,
    tls: Option<bool>,
) -> Result<crate::http_client::HttpResponse, String> {
    // https:// URLs are wrapped in real TLS (verified against the web PKI) —
    // previously the scheme was dropped and HTTPS went out as plaintext (SEC-003).
    let use_tls = tls.unwrap_or(false);
    let conn = get_conn(&*state.sessions.lock().await, &session_id)?;

    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Write};
        use std::collections::HashMap;
        use std::time::Instant;

        let session_guard = conn.sftp_session.lock()
            .unwrap_or_else(|e| e.into_inner());

        let mut channel = session_guard
            .channel_direct_tcpip(&remote_host, remote_port, None)
            .map_err(|e| format!("Tunnel open failed ({}:{}) — {}", remote_host, remote_port, e))?;

        let t0 = Instant::now();

        // Build request headers
        let default_port = if use_tls { 443 } else { 80 };
        let host_header = if remote_port == default_port {
            remote_host.clone()
        } else {
            format!("{}:{}", remote_host, remote_port)
        };

        let body_bytes = body.as_deref().unwrap_or("").as_bytes().to_vec();

        let mut hmap: HashMap<String, String> = HashMap::new();
        hmap.insert("Host".to_string(), host_header);
        hmap.insert("Connection".to_string(), "close".to_string());
        if !body_bytes.is_empty() {
            hmap.insert("Content-Length".to_string(), body_bytes.len().to_string());
        }
        // Strip CR/LF before embedding caller-supplied values into the raw HTTP
        // request.  Without this a malicious header value or path could inject an
        // arbitrary second request line or override Host/Connection headers (CRLF
        // injection / HTTP request smuggling).
        fn strip_crlf(s: &str) -> String {
            s.replace(['\r', '\n'], "")
        }

        for h in &headers {
            let name  = strip_crlf(h.name.trim());
            let value = strip_crlf(h.value.trim());
            // Reject empty names and colons inside the name (would corrupt
            // the "field-name: field-value" wire format).
            if !name.is_empty() && !name.contains(':') && !value.is_empty() {
                hmap.insert(name, value);
            }
        }

        let sanitized_path = {
            let p = path.trim();
            let p = if p.is_empty() { "/" } else { p };
            strip_crlf(p)
        };
        // Method must be ASCII letters only (RFC 7230 §3.1.1).
        let method_safe: String = method.to_uppercase()
            .chars()
            .filter(|c| c.is_ascii_alphabetic())
            .collect();
        if method_safe.is_empty() {
            return Err("tunnel_http_request: invalid HTTP method".to_string());
        }

        let mut raw = format!("{} {} HTTP/1.1\r\n", method_safe, sanitized_path);
        for (k, v) in &hmap {
            raw.push_str(&format!("{}: {}\r\n", k, v));
        }
        raw.push_str("\r\n");

        let mut request_bytes = raw.into_bytes();
        request_bytes.extend_from_slice(&body_bytes);

        let buf = if use_tls {
            let mut tls = crate::tunnel_tls::connect(&remote_host, channel)?;
            tls.write_all(&request_bytes).map_err(|e| format!("TLS write: {}", e))?;
            tls.flush().map_err(|e| format!("TLS write: {}", e))?;
            crate::tunnel_tls::read_response(&mut tls)?
        } else {
            channel.write_all(&request_bytes).map_err(|e| format!("Tunnel write: {}", e))?;
            channel.send_eof().map_err(|e| format!("Tunnel EOF: {}", e))?;
            let mut buf = Vec::new();
            (&mut channel).take(crate::http_client::MAX_BODY_BYTES + 64 * 1024)
                .read_to_end(&mut buf).map_err(|e| format!("Tunnel read: {}", e))?;
            buf
        };

        let latency_ms = t0.elapsed().as_millis() as u64;
        crate::http_client::parse_raw_http_response(&buf, latency_ms)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod live_ssh_tests {
    //! Opt-in tests against a real, DISPOSABLE sshd:
    //!   PINGNET_TEST_SSH="127.0.0.1:2222:user:password" cargo test -- --ignored live_ssh --test-threads=1
    //! The user needs sudo rights (password-protected) on that host.
    use super::*;
    fn cfg() -> (String, u16, String, String) {
        let v = std::env::var("PINGNET_TEST_SSH").expect("set PINGNET_TEST_SSH=host:port:user:password");
        let mut it = v.splitn(4, ':');
        let (h, p, u, pw) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
        (h.to_string(), p.parse().unwrap(), u.to_string(), pw.to_string())
    }

    fn sess() -> Session {
        let (host, port, user, pw) = cfg();
        let s = Session::new().unwrap();
        configure_session_algorithms(&s);
        s.set_timeout(SETUP_TIMEOUT_MS);
        let mut s = s;
        s.set_tcp_stream(tcp_connect(&host, port).unwrap());
        s.handshake().unwrap();
        s.userauth_password(&user, &pw).unwrap();
        s
    }

    #[test]
    #[ignore = "needs a disposable sshd (PINGNET_TEST_SSH)"]
    fn live_ssh_sudo_password_via_stdin_not_argv() {
        let pw_owned = cfg().3;
        let pw = pw_owned.as_str();
        let s = sess();
        let rc = crate::remote::sudo_cmd("id -u; ps -eo args", &Some(pw.into()));
        // NB: run this from a shell whose own argv doesn't contain the password,
        // or the process-list check will (correctly) flag your test runner.
        assert!(!rc.cmd.contains(pw));
        let (out, _, code) = crate::remote::run(&s, &rc, true).unwrap();
        println!("exit={} first={:?} len={}", code, out.lines().next(), out.len());
        assert_eq!(code, 0);
        assert_eq!(out.lines().next(), Some("0"));
        assert!(!out.contains(pw), "password visible in process list!");
    }

    #[test]
    #[ignore = "needs a disposable sshd (PINGNET_TEST_SSH)"]
    fn live_ssh_wrong_sudo_password_fails_fast() {
        let s = sess();
        let t = std::time::Instant::now();
        let (out, _, code) = crate::remote::run(&s, &crate::remote::sudo_cmd("id -u", &Some("nope".into())), true).unwrap();
        println!("wrong pw: exit={} out={:?} in {:?}", code, out.trim(), t.elapsed());
        assert_ne!(code, 0);
        assert!(t.elapsed() < Duration::from_secs(15));
    }

    #[test]
    #[ignore = "needs a disposable sshd (PINGNET_TEST_SSH)"]
    fn live_ssh_huge_stderr_does_not_deadlock_when_merged() {
        let s = sess();
        s.set_timeout(30_000);
        let t = std::time::Instant::now();
        let (out, _, code) = crate::remote::run(&s, &crate::remote::RemoteCmd::plain("head -c 4000000 /dev/zero | tr '\\0' e >&2; echo done"), true).unwrap();
        println!("merged 4MB stderr: exit={} len={} in {:?}", code, out.len(), t.elapsed());
        // merged mode doesn't preserve stdout/stderr ordering — only completeness
        assert!(out.contains("done") && out.len() == 4_000_005);
    }

    #[test]
    #[ignore = "needs a disposable sshd (PINGNET_TEST_SSH)"]
    fn live_ssh_silent_server_handshake_times_out() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || { let _c = l.accept(); std::thread::sleep(Duration::from_secs(30)); });
        let mut s = Session::new().unwrap();
        s.set_timeout(2000);
        s.set_tcp_stream(tcp_connect("127.0.0.1", port).unwrap());
        let t = std::time::Instant::now();
        let r = s.handshake();
        println!("silent server: {:?} after {:?}", r.as_ref().err().map(|e| e.to_string()), t.elapsed());
        assert!(r.is_err());
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    #[ignore = "needs a disposable sshd (PINGNET_TEST_SSH)"]
    fn live_ssh_tcp_connect_to_blackhole_times_out() {
        // 10.255.255.1 is unroutable here — connect_timeout must bound it
        let t = std::time::Instant::now();
        let r = tcp_connect("10.255.255.1", 22);
        println!("blackhole: {:?} after {:?}", r.as_ref().err(), t.elapsed());
        assert!(r.is_err());
        assert!(t.elapsed() < Duration::from_secs(12));
    }
}
