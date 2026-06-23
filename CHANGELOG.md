# Changelog

All notable changes to Pingnet are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

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
