//! Detection of inline credentials in shell commands. Shared by the command
//! history, the audit log and the frontend (via `is_sensitive_command`) so every
//! sink applies the same policy (audit SEC-001).

/// True when a command line likely contains an inline secret (password flag,
/// token env var, Authorization header, URL userinfo, sshpass, …).
pub fn looks_sensitive(cmd: &str) -> bool {
    let cmd = cmd.trim();
    let lower = cmd.to_lowercase();

    // Long-form flag patterns
    let flag_patterns = [
        "--password", "--passwd", "--pass",
        "--token", "--secret", "--api-key", "--apikey",
        "--auth-token", "--access-token", "--private-key",
        "--client-secret", "--aws-secret",
    ];
    if flag_patterns.iter().any(|p| lower.contains(p)) {
        return true;
    }

    // sshpass / ssh-pass wrapper
    if lower.starts_with("sshpass") || lower.contains(" sshpass ") {
        return true;
    }

    // curl -u user:pass  (short -u flag followed by non-whitespace containing colon)
    if lower.contains("curl") {
        // Look for "-u " or "-u:" followed by something with a colon (basic-auth)
        let has_curl_u = lower.contains(" -u ") || lower.contains("\t-u ");
        if has_curl_u {
            return true;
        }
        // curl -H "Authorization: ..." header flag
        // Catches both short (-H) and long (--header) forms with auth values
        if lower.contains("-h ") || lower.contains("--header ") {
            let auth_header_patterns = [
                "authorization:", "x-api-key:", "x-auth-token:",
                "bearer ", "token ", "basic ",
            ];
            if auth_header_patterns.iter().any(|p| lower.contains(p)) {
                return true;
            }
        }
    }

    // Generic -H / --header flags (wget, httpie, custom curl wrappers, etc.)
    // Catches: -H "Authorization: Bearer <token>" regardless of the outer tool.
    {
        let has_header_flag = lower.contains(" -h ") || lower.contains("\t-h ")
            || lower.contains(" --header ") || lower.contains("\t--header ");
        if has_header_flag {
            let auth_header_values = [
                "authorization:", "x-api-key:", "x-auth-token:",
                "bearer ", "basic ",
            ];
            if auth_header_values.iter().any(|p| lower.contains(p)) {
                return true;
            }
        }
    }

    // Bare Authorization/Bearer patterns outside of a -H flag
    // (e.g. httpie: `http GET /api Authorization:"Bearer xyz"`)
    {
        let inline_auth_patterns = [
            "authorization:bearer ", "authorization:basic ",
            "authorization: bearer ", "authorization: basic ",
            "bearer eyj",  // JWT — starts with base64-encoded '{"'
        ];
        if inline_auth_patterns.iter().any(|p| lower.contains(p)) {
            return true;
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
                    return true;
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
        return true;
    }

    // URL userinfo: scheme://user:pass@host
    // Look for "://" followed anywhere by "@" with a ":" between them.
    if let Some(scheme_end) = lower.find("://") {
        let after = &lower[scheme_end + 3..];
        if let Some(at_pos) = after.find('@') {
            let before_at = &after[..at_pos];
            // If there's a colon before the @, there are credentials in the URL
            if before_at.contains(':') {
                return true;
            }
        }
    }

    false
}

/// Audit-log representation of a sensitive command: records THAT it ran
/// (tool name) without the arguments that carry the secret.
pub fn redact(cmd: &str) -> String {
    let base = cmd.split_whitespace().next().unwrap_or("");
    format!("{} … [redacted: contains credentials]", base)
}

#[tauri::command]
pub fn is_sensitive_command(command: String) -> bool {
    looks_sensitive(&command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_inline_secrets() {
        for c in [
            "mysql -u root -phunter2 db",
            "curl -H 'Authorization: Bearer abc' https://x",
            "TOKEN=abc ./deploy.sh",
            "git clone https://user:pw@github.com/x/y",
            "sshpass -p pw ssh host",
            "aws configure set aws_secret_access_key XYZ",
            "tool --password s3cret",
        ] {
            assert!(looks_sensitive(c), "should flag: {}", c);
        }
    }

    #[test]
    fn leaves_ordinary_commands_alone() {
        for c in ["ls -la", "docker ps -a", "ssh -p 2222 host", "grep -r pattern .", "ping -c 3 10.0.0.1"] {
            assert!(!looks_sensitive(c), "should not flag: {}", c);
        }
    }

    #[test]
    fn redaction_keeps_only_the_tool_name() {
        assert_eq!(redact("mysql -u root -phunter2"), "mysql … [redacted: contains credentials]");
    }
}
