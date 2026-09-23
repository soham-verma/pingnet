//! Running commands on a remote host over an existing SSH session.
//!
//! sudo passwords are written to the channel's STDIN (`sudo -S -p ''`) — never
//! interpolated into the command string, which the remote login shell receives
//! as an argument and which is therefore visible in the process list
//! (/proc/<pid>/cmdline) to other users on that host (audit SEC-002).

use std::io::{Read, Write};

/// POSIX single-quote for safe shell embedding.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A command plus optional data to feed to its stdin.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteCmd {
    pub cmd: String,
    pub stdin: Option<String>,
}

impl RemoteCmd {
    pub fn plain(cmd: &str) -> Self {
        RemoteCmd { cmd: cmd.to_string(), stdin: None }
    }
}

/// Wrap `cmd` to run under sudo when a (non-empty) password is supplied.
/// The whole command runs inside `sh -c` so pipes and redirections are
/// elevated too, not just the first word.
pub fn sudo_cmd(cmd: &str, sudo_password: &Option<String>) -> RemoteCmd {
    match sudo_password.as_deref().filter(|p| !p.is_empty()) {
        Some(pw) => RemoteCmd {
            cmd: format!("sudo -S -p '' sh -c {}", shell_quote(cmd)),
            // sudo reads one line; strip newlines so a pasted password can't
            // leak its remainder into the command's stdin
            stdin: Some(format!("{}\n", pw.replace(['\r', '\n'], ""))),
        },
        None => RemoteCmd::plain(cmd),
    }
}

/// Exec on a new channel, feed stdin (then EOF), and collect output.
/// With `merge_stderr`, stderr is interleaved into stdout by libssh2 — this
/// also avoids the read-stdout-then-stderr deadlock when a command writes a
/// lot to stderr. Returns (stdout, stderr, exit_status).
pub fn run(session: &ssh2::Session, rc: &RemoteCmd, merge_stderr: bool) -> Result<(String, String, i32), String> {
    let mut ch = session.channel_session().map_err(|e| format!("channel: {}", e))?;
    if merge_stderr {
        ch.handle_extended_data(ssh2::ExtendedData::Merge).map_err(|e| e.to_string())?;
    }
    ch.exec(&rc.cmd).map_err(|e| format!("exec: {}", e))?;
    if let Some(input) = &rc.stdin {
        ch.write_all(input.as_bytes()).map_err(|e| format!("stdin: {}", e))?;
    }
    ch.send_eof().map_err(|e| format!("stdin eof: {}", e))?;

    let mut stdout = Vec::new();
    ch.read_to_end(&mut stdout).map_err(|e| format!("read stdout: {}", e))?;
    let mut stderr = Vec::new();
    if !merge_stderr {
        ch.stderr().read_to_end(&mut stderr).map_err(|e| format!("read stderr: {}", e))?;
    }
    let _ = ch.wait_close();
    // -1 = no exit status reported (killed by signal / channel closed early)
    let exit = ch.exit_status().unwrap_or(-1);
    Ok((
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
        exit,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_never_appears_in_command_string() {
        let rc = sudo_cmd("docker ps 2>&1 | head", &Some("hunter2'x".into()));
        assert!(!rc.cmd.contains("hunter2"));
        assert_eq!(rc.stdin.as_deref(), Some("hunter2'x\n"));
        assert!(rc.cmd.starts_with("sudo -S -p '' sh -c "));
    }

    #[test]
    fn no_password_means_no_sudo() {
        assert_eq!(sudo_cmd("ls", &None), RemoteCmd::plain("ls"));
        assert_eq!(sudo_cmd("ls", &Some(String::new())), RemoteCmd::plain("ls"));
    }

    #[test]
    fn newline_in_password_is_stripped() {
        let rc = sudo_cmd("id", &Some("a\nrm -rf /".into()));
        assert_eq!(rc.stdin.as_deref(), Some("arm -rf /\n"));
    }

    #[test]
    fn wrapped_command_is_valid_sh() {
        let rc = sudo_cmd("echo 'it''s' && ls | wc -l", &Some("pw".into()));
        let inner = rc.cmd.trim_start_matches("sudo -S -p '' ");
        let st = std::process::Command::new("sh").args(["-n", "-c", inner]).status().unwrap();
        assert!(st.success());
    }
}
