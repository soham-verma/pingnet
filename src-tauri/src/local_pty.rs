//! Local PTY — spawn a shell on the user's own machine and stream its output
//! back to the frontend using the same event protocol as the SSH module.
//!
//! Events emitted (identical names to SSH so SSHTerminal.tsx works unchanged):
//!   ssh-output-{session_id}  — payload: String (raw terminal bytes)
//!   ssh-closed-{session_id}  — payload: null   (shell exited)
//!
//! Commands exposed:
//!   local_pty_start(session_id)
//!   local_pty_send(session_id, data)
//!   local_pty_resize(session_id, cols, rows)
//!   local_pty_stop(session_id)

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

// ── Session state ─────────────────────────────────────────────────────────────

struct LocalPtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

pub struct LocalPtyState {
    sessions: Mutex<HashMap<String, LocalPtySession>>,
}

impl LocalPtyState {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Detect the user's preferred shell. Reads $SHELL, falling back to /bin/zsh
/// (macOS default since Catalina) then /bin/bash.
fn detect_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if std::path::Path::new("/bin/zsh").exists() {
            "/bin/zsh".to_string()
        } else {
            "/bin/bash".to_string()
        }
    })
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Spawn a local shell session bound to `session_id`.
/// Output is forwarded as `ssh-output-{session_id}` events.
/// Shell exit fires `ssh-closed-{session_id}`.
#[tauri::command]
pub fn local_pty_start(
    session_id: String,
    app: tauri::AppHandle,
    state: tauri::State<LocalPtyState>,
) -> Result<(), String> {
    // Tear down any existing session with this ID first
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.remove(&session_id);
    }

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = detect_shell();
    let mut cmd = CommandBuilder::new(&shell);

    // Pass through the user's environment so PATH, TERM, etc. are set correctly
    cmd.env("TERM", "xterm-256color");
    // HOME is inherited automatically from the spawned process environment

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Spawn a thread to forward PTY output → Tauri events
    let app_clone = app.clone();
    let sid = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    // Shell exited or PTY closed
                    let _ = app_clone.emit(&format!("ssh-closed-{}", sid), ());
                    break;
                }
                Ok(n) => {
                    // Convert bytes to a lossy UTF-8 string — xterm handles raw bytes fine
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_clone.emit(&format!("ssh-output-{}", sid), text);
                }
            }
        }
    });

    let session = LocalPtySession {
        writer,
        master: pair.master,
    };

    state.sessions.lock().unwrap().insert(session_id, session);
    Ok(())
}

/// Send raw input bytes to a local PTY session.
#[tauri::command]
pub fn local_pty_send(
    session_id: String,
    data: String,
    state: tauri::State<LocalPtyState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("No local PTY session: {session_id}"))?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

/// Resize the PTY window for a local session.
#[tauri::command]
pub fn local_pty_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<LocalPtyState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("No local PTY session: {session_id}"))?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Terminate a local PTY session.
#[tauri::command]
pub fn local_pty_stop(
    session_id: String,
    state: tauri::State<LocalPtyState>,
) -> Result<(), String> {
    state.sessions.lock().unwrap().remove(&session_id);
    Ok(())
}
