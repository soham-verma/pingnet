# Changelog

All notable changes to Pingnet are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

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
