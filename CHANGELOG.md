# Changelog

All notable changes to Pingnet are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [0.4.2] — 2026-06-26

### Added

**Cross-platform SSH Metrics**
- macOS support: CPU% via `top -l 2`, memory via `vm_stat` + `sysctl hw.memsize`, network rates via `netstat -ib`, processes via `ps -A`, load average via `sysctl vm.loadavg`, uptime via `kern.boottime`, disk via `df -k /`
- Windows support: CPU% via `Win32_Processor`, memory/uptime via `Win32_OperatingSystem`, disk via `Get-PSDrive C`, network bytes via `Get-NetAdapterStatistics`, processes via `Get-Process` — all via a single PowerShell one-liner over SSH
- OS auto-detected on connect (`uname -s` → Darwin/Linux, PowerShell fallback for Windows); metrics panel now works on any SSH target
- `os_type` field added to `MetricsSnapshot` so the UI can adapt labels (e.g. CPU column shows "s" for Windows process CPU time, "%" for Linux/macOS)

**Sortable Process Table**
- Clicking any column header (PID, Name, CPU, MEM) sorts the process list by that field
- Clicking the active column again reverses direction; a small arrow indicates sort state
- Defaults to CPU descending on load

**Docker Manager**
- New **Docker** tab in SSH sessions — lists all containers with state, image, ports, and uptime
- Start / stop / restart / remove individual containers; view last 200 log lines in a scrollable pane
- Docker Compose project view — list stacks, bring them up/down/restart, pull latest images
- `docker system df` disk usage summary; `docker system prune` with confirmation
- Works over the existing SSH session — no extra connection or daemon port required

---

## [0.4.1] — 2026-06-26

### Security

- **`open_url` scheme allowlist** — only `https://`, `mailto:`, `vscode://`, `cursor://`, `windsurf://`, and JetBrains schemes are permitted; `file://`, `javascript:`, `data:` and all unlisted schemes are blocked
- **`write_text_file` sensitive-path blocklist** — writes to `~/.ssh/`, `~/.aws/`, `~/.zshrc`, `~/.bashrc`, `~/.gitconfig`, `authorized_keys`, and ~10 other shell/credential files are rejected even within the home directory
- **Host-key fingerprint hardened** — replaced MD5 `host_key_hash` with raw key bytes (hex-encoded, prefixed with key type) for collision-resistant TOFU verification
- **CRLF injection fix in SSH tunnel** — `\r`/`\n` are now stripped from all caller-supplied method, path, and header values before being embedded in the raw HTTP request
- **SSRF: cloud metadata blocked** — `make_http_request` rejects requests to `169.254.169.254`, GCP metadata, Alibaba Cloud, and Oracle Cloud IMDS endpoints
- **Secret redaction extended** — command history now also redacts `-H "Authorization: Bearer …"`, `x-api-key:`, `x-auth-token:`, bare `authorization:bearer`, and JWT (`eyJ…`) patterns
- **CSP `frame-src` tightened** — non-HTTPS frames restricted to loopback (`http://localhost:*`, `http://127.0.0.1:*`) only; HTTPS remote Grafana still works

### Fixed

- **BUG-01** — deleting a host now requires confirmation; one stray click no longer permanently destroys the host config
- **BUG-02** — generating an SSH key with a duplicate name now warns before overwriting the existing keychain entry
- **BUG-03** — Add/Edit Host modal is now scrollable with `max-height: 85vh`; header and action buttons are always reachable
- **BUG-04** — Escape now reliably closes the Add/Edit Host modal (switched to `document` listener + `onKeyDown` fallback)
- **BUG-05** — resizing the window can no longer push the sidebar off the left edge of the screen; position is clamped to monitor bounds on every resize event
- **BUG-06** — deleting an SSH key now requires confirmation
- **BUG-07** — IP validation now rejects octets > 255 (e.g. `999.999.999.999`); the over-broad `^[\w.-]+$` hostname fallback is removed
- **BUG-08** — SSH Connect now shows an inline error on empty username or incomplete TOTP code instead of silently doing nothing
- **BUG-09** — SSH Connect validates port range (1–65535) before connecting
- **BUG-10** — the "KEY GENERATED" public-key banner is cleared when the key is deleted
- **BUG-11** — alert toggles in the host form are now keyboard-accessible (`role="switch"`, `tabIndex`, Space/Enter support)

### Other

- Extract `computeNextAlertState` and `releaseNotes` utilities as pure, testable functions
- Add 48 Playwright unit tests covering the alert state machine, network utilities, and semver helpers
- CI: add `Swatinem/rust-cache` to release workflow to prevent transient crates.io failures

---

## [0.2.0] — 2026-06-24

### Added

**Ping Alerts**
- Per-host alert toggles: notify when host goes down, when it recovers, and when latency exceeds a threshold
- Native desktop notifications (macOS Notification Center, Windows, Linux)
- 30-second background auto-ping for hosts with any alert enabled — state-transition detection avoids duplicate alerts
- Alert settings in the Add / Edit Host modal (toggles + latency threshold field)

**Live Server Metrics**
- New **Metrics** tab in SSH sessions — shows CPU %, memory used/total, disk usage (root), 1-min load average, and uptime
- Metrics collected over existing SFTP session (no extra TCP connection) by reading `/proc/stat`, `/proc/loadavg`, `/proc/uptime`, `free -m`, `df /`
- Delta-based CPU percentage (accurate across polls)
- Auto-refreshes every 3 seconds while the tab is visible; pauses when navigating away
- Red/amber colour-coding when values exceed 70 % / 90 %

**SSH Key Manager**
- Generate Ed25519 keypairs inside Pingnet — private keys stored in OS keychain (macOS Keychain, Windows Credential Manager, Linux SecretService)
- Key list with one-click public-key copy, per-key delete
- New **Keychain** auth option in the SSH connect modal — pick a managed key, no file path needed
- In-memory SSH auth via `userauth_pubkey_memory` — private key never written to disk

### Changed
- SSH connect modal gains a third auth tab ("Keychain") alongside Password and Key File
- `HostConfig` gains `alert_on_down`, `alert_on_recovery`, `alert_latency_ms` — fully backward-compatible (existing JSON deserialises with defaults `false / null`)
- Sidebar gets an **SSH Keys** button at the bottom for quick key manager access
- `usePing` now accepts the host list and manages per-host auto-ping intervals internally

---

## [0.1.1] — 2026-06-24

### Fixed
- Tab key in SSH terminal no longer shifts focus to the close button
- Commands from sub-tools (psql, python, etc.) no longer appear in bash history
- History play button now auto-navigates back to the Terminal tab

### Security
- SSH TOFU host-key pinning (MD5 fingerprint stored in `known_hosts.json`)
- Command history redacts secrets (`--password`, `--token`, `--api-key`, etc.)
- CSP policy added to `tauri.conf.json`
- SFTP upload rejects paths containing `..`
- SFTP download sanitises server-supplied filenames
- Ping validates host input to block leading-dash injection
- UTF-8 safe truncation in ping output

---

## [0.1.0] — 2026-06-24

First public release.

### Added

**Ping & Diagnostics**
- Add / edit / delete hosts by IP or hostname
- One-click ICMP ping with real-time latency chart
- VPN detection on macOS (scutil), Linux (ip / nmcli), and Windows (netsh / Get-VpnConnection)
- Smart failure diagnostics — classifies timeout, no-route, DNS failure, permission denied
- Animated diagnostic console log
- Host list persistence (JSON in app data directory)

**SSH Client**
- Embedded terminal (xterm.js) — no external terminal required
- Multi-terminal tabs with per-tab rename (double-click)
- Password and SSH key authentication
- Pre-flight ICMP ping check before every connection attempt
- Graceful connection-loss detection with one-click reconnect overlay
- Fish-style ghost-text autosuggestions from persistent command history (Tab / → to accept)
- Persistent command history per host — survives disconnects and reboots
- Command history panel with search, grouped by tool, click-to-run
- "New tool detected" notification on first use of a command

**SFTP File Browser**
- Browse, upload, download, rename, delete, create folders over SSH
- File transfer queue with per-file progress bars

**Platforms**
- macOS `.app` / `.dmg`
- Linux `.AppImage` / `.deb`
- Windows `.msi` / `.exe`
