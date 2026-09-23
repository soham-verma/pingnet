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

use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

// ── Session state ─────────────────────────────────────────────────────────────

struct LocalPtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// Kept so closing the tab can terminate and reap the shell (audit BUG-011)
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

impl LocalPtySession {
    /// Kill the shell (and with it the PTY's foreground job) and reap it.
    fn terminate(self) {
        let child = self.child;
        drop(self.writer);
        drop(self.master); // closes the PTY — the reader thread sees EOF
        std::thread::spawn(move || {
            let mut c = child.lock().unwrap_or_else(|e| e.into_inner());
            if let Ok(None) = c.try_wait() {
                let _ = c.kill();
            }
            let _ = c.wait(); // reap — no zombie
        });
    }
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

/// Shell program + startup args for this platform (audit BUG-016).
/// Unix: $SHELL (fallback zsh → bash → sh) as a login shell so PATH setup in
/// ~/.zprofile etc. runs. Windows: PowerShell 7 (pwsh) if installed, else
/// Windows PowerShell, else %COMSPEC% (cmd.exe) — never a Unix path or `-l`.
fn detect_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let in_path = |exe: &str| {
            std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
                .unwrap_or(false)
        };
        if in_path("pwsh.exe") {
            return ("pwsh.exe".into(), vec!["-NoLogo".into()]);
        }
        if in_path("powershell.exe") {
            return ("powershell.exe".into(), vec!["-NoLogo".into()]);
        }
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        return (comspec, vec![]);
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").ok().filter(|s| std::path::Path::new(s).exists()).unwrap_or_else(|| {
            ["/bin/zsh", "/bin/bash", "/bin/sh"]
                .iter()
                .find(|p| std::path::Path::new(p).exists())
                .unwrap_or(&"/bin/sh")
                .to_string()
        });
        (shell, vec!["-l".into()])
    }
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
    if let Some(old) = state.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&session_id) {
        old.terminate();
    }

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let (shell, args) = detect_shell();
    let mut cmd = CommandBuilder::new(&shell);
    // Unix: force a login shell so PATH setup in ~/.zprofile (Homebrew, nvm, …)
    // runs — CommandBuilder's argv[0] has no leading "-". Windows: -NoLogo.
    for a in &args {
        cmd.arg(a);
    }
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    // Pass through the user's environment so PATH, TERM, etc. are set correctly
    cmd.env("TERM", "xterm-256color");
    // HOME is inherited automatically from the spawned process environment

    let child: Arc<Mutex<Box<dyn Child + Send + Sync>>> =
        Arc::new(Mutex::new(pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?));
    // The slave end belongs to the child now; keeping it open here would stop
    // the reader from ever seeing EOF when the shell exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Spawn a thread to forward PTY output → Tauri events
    let app_clone = app.clone();
    let sid = session_id.clone();
    let child_r = child.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    // Shell exited or PTY closed — reap if it already exited
                    if let Ok(mut c) = child_r.try_lock() {
                        let _ = c.try_wait();
                    }
                    let _ = app_clone.emit(&format!("ssh-closed-{}", sid), ());
                    break;
                }
                Ok(n) => {
                    // Decode across reads so multi-byte characters never split
                    pending.extend_from_slice(&buf[..n]);
                    let text = crate::utf8_stream::take_utf8(&mut pending);
                    if !text.is_empty() {
                        let _ = app_clone.emit(&format!("ssh-output-{}", sid), text);
                    }
                }
            }
        }
    });

    let session = LocalPtySession {
        writer,
        master: pair.master,
        child,
    };

    state.sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(session_id, session);
    Ok(())
}

/// Send raw input bytes to a local PTY session.
#[tauri::command]
pub fn local_pty_send(
    session_id: String,
    data: String,
    state: tauri::State<LocalPtyState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
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
    let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
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
    if let Some(s) = state.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&session_id) {
        s.terminate();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_shell_is_platform_appropriate() {
        let (shell, args) = detect_shell();
        if cfg!(windows) {
            assert!(!shell.starts_with('/'));
            assert!(!args.contains(&"-l".to_string()));
        } else {
            assert!(shell.starts_with('/'));
            assert_eq!(args, vec!["-l".to_string()]);
        }
    }

    /// Spawn a long-running child in a real PTY, terminate the session the way
    /// local_pty_stop does, and check the process is gone (BUG-011).
    #[cfg(unix)]
    #[test]
    fn terminate_kills_and_reaps_the_child() {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("300");
        let child = pair.slave.spawn_command(cmd).unwrap();
        let pid = child.process_id().unwrap();
        drop(pair.slave);
        let writer = pair.master.take_writer().unwrap();
        let s = LocalPtySession { writer, master: pair.master, child: Arc::new(Mutex::new(child)) };
        s.terminate();
        let alive = || std::path::Path::new(&format!("/proc/{}", pid)).exists()
            || std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().map(|st| st.success()).unwrap_or(false);
        for _ in 0..50 {
            if !alive() { return; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("child {} still alive after terminate()", pid);
    }
}
