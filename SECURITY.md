# Security Policy

## Supported Versions

Only the latest release receives security fixes.

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email [contact@sohamverma.com](mailto:contact@sohamverma.com) with:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- The version of Pingnet you tested against
- Your preferred credit (name / handle) if you'd like to be acknowledged

You should receive a response within **72 hours**. If you haven't heard back, follow up in the same thread.

## Scope

Pingnet is a local desktop app — it runs entirely on your machine and does not have a backend server or cloud component. The relevant attack surface is:

- **SSH credential handling** — passwords and key passphrases are held in memory only and never written to disk by Pingnet
- **SFTP file operations** — path traversal or unintended file access
- **IPC between the Rust backend and the React frontend** — Tauri command injection or privilege escalation
- **Update check** — the app fetches `api.github.com` to check for new releases; any MITM or response-spoofing that could redirect users to malicious downloads

Out of scope: social engineering, physical access to the machine, issues in upstream dependencies (report those directly to the relevant project).

## Disclosure Policy

Once a fix is ready and released, vulnerabilities will be disclosed publicly in the release notes with credit to the reporter. The typical timeline from report to disclosure is under 14 days for critical issues.

## Security Design Notes

- Pingnet uses [Tauri 2](https://tauri.app), which sandboxes the frontend webview and restricts IPC via a capability system (`src-tauri/capabilities/`)
- SSH passwords are never persisted — only the username, port, and auth type are saved to disk
- There is no telemetry, analytics, or remote logging of any kind
