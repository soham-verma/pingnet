# Pingnet

A cross-platform network diagnostics desktop app for developers and sysadmins. Built with [Tauri 2](https://tauri.app), React, and Rust.

![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)
![Platform: macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB)

---

## Features

### Ping & Diagnostics
- Add hosts by IP or hostname with custom display names
- One-click ping with real-time latency graph
- Smart failure diagnostics — detects active VPNs, missing routes, DNS failures
- Animated diagnostic console with timestamped entries

### SSH Client (embedded)
- Full terminal emulator (xterm.js) directly in the app — no external terminal needed
- Multi-terminal tabs with rename support (like VS Code)
- Password and SSH key authentication
- Pre-flight connectivity check before every connection attempt
- Graceful connection-loss detection with one-click reconnect

### SFTP File Browser
- Browse, download, upload, rename, delete, and create folders over SSH
- Transfer queue with per-file progress
- Upload directly from your computer via drag-and-drop

### Command History
- Every command you run is persisted per host — survives disconnects and reboots
- Fish-style ghost-text autosuggestions from your history (Tab or → to accept)
- Captures tab-completed and up-arrow-recalled commands accurately by reading the terminal buffer
- History panel with search, grouped by tool, click-to-run

---

## Screenshots

> Coming soon.

---

## Getting Started

### Prerequisites

| Tool | Install |
|------|---------|
| Rust + Cargo | https://rustup.rs |
| Node.js 18+ | https://nodejs.org |
| Xcode CLI (macOS) | `xcode-select --install` |

### Dev

```bash
npm install
npm run tauri dev
```

> **First run after cloning:** the `ssh2` crate compiles OpenSSL from source (~3–5 min). Subsequent builds are fast.

### Build (packaged app)

```bash
npm run tauri build
```

Outputs:
- **macOS** — `src-tauri/target/release/bundle/macos/Pingnet.app` + `.dmg`
- **Linux** — `src-tauri/target/release/bundle/appimage/*.AppImage` + `deb/*.deb`

### Quick start (macOS)

Double-click `run-dev.command` in the project root. It checks dependencies, clears the dev port, and launches the app.

---

## Project Structure

```
src/                          React + TypeScript frontend
  App.tsx                     Root layout — sidebar, ping view, SSH view
  types.ts                    Shared TypeScript types
  components/
    Sidebar.tsx               Host list with ping status indicators
    HostDetailView.tsx        Ping dashboard — latency chart, diagnostics
    AddEditModal.tsx          Add / edit host form
    ssh/
      SSHSessionView.tsx      SSH view — tab bar, panel routing
      SSHTerminal.tsx         xterm.js terminal + ghost-text suggestions
      SSHConnectModal.tsx     Auth form (password / SSH key)
      SFTPBrowser.tsx         File browser with breadcrumbs
      TransferQueue.tsx       Upload / download progress
      CommandHistory.tsx      Persistent command history panel
  hooks/
    usePing.ts                Ping state, session history, diagnostic logs

src-tauri/src/                Rust backend
  lib.rs                      Tauri command registration
  ping.rs                     Cross-platform ping + error classification
  vpn.rs                      VPN detection (macOS: scutil, Linux: ip/nmcli)
  storage.rs                  JSON host persistence (app data dir)
  ssh.rs                      SSH shell + SFTP commands (ssh2 crate)
  command_history.rs          Per-host command history persistence
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2 |
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS |
| Terminal | xterm.js (+ FitAddon, WebLinksAddon) |
| Backend | Rust |
| SSH / SFTP | ssh2 crate (vendored OpenSSL) |

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.

## License

GPL v3 — see [LICENSE](LICENSE).

You are free to use, modify, and distribute this software under the terms of the GPL v3. Any derivative work distributed publicly must also be released under GPL v3.
