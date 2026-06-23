# Changelog

All notable changes to Pingnet are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- Embedded SSH terminal (xterm.js) — no external terminal required
- Multi-terminal tabs with per-tab rename (double-click)
- SFTP file browser — browse, upload, download, rename, delete, create folders
- File transfer queue with per-file progress bars
- Pre-flight ICMP ping check before every SSH connection attempt
- Graceful connection-loss detection with reconnect overlay
- Persistent command history per host (survives disconnects and reboots)
- Fish-style ghost-text autosuggestions from command history (Tab / → to accept)
- Command history panel with search, grouped by tool, click-to-run
- "New tool detected" notification on first use of a command

---

## [0.1.0] — 2024

### Added
- Initial release
- Add / edit / delete hosts by IP or hostname
- One-click ICMP ping with real-time latency chart
- VPN detection on macOS (scutil) and Linux (ip / nmcli)
- Smart failure diagnostics — classifies timeout, no-route, DNS failure, permission denied
- Animated diagnostic console log
- Host list persistence (JSON in app data directory)
- macOS `.app` and Linux `.AppImage` / `.deb` build targets
