# Pingnet — LinkedIn Promo Video Guide

**Target length:** 60–75 seconds  
**Format:** 1920×1080 landscape (or crop to 1080×1080 square for LinkedIn feed)  
**Vibe:** Clean, fast, confident. Developer tool energy — not a sales pitch.

---

## Setup before recording

1. Launch Pingnet with **2–3 hosts already added** (e.g. "Production Server", "Dev Box", "Office NAS")
2. Have one host that's actively responding to ping so the latency chart is alive
3. Pre-configure SSH credentials so the connection modal auto-fills
4. Have a few files in the SFTP browser root so it looks lived-in
5. Have 6–8 commands already in history so the history panel looks real
6. Set screen resolution to **1440p or 1080p** — crisp on LinkedIn
7. Hide your dock / taskbar, close other windows
8. Use **QuickTime Player → New Screen Recording** (macOS) or **OBS** for recording

---

## Shot List — 70 seconds

> ⏱ Timings are approximate. Add 0.5s pauses between scenes so the editor can cut cleanly.

---

### Scene 1 — Cold open (0–4s)
**Action:** App is already open. A ping is mid-flight — the green latency bars are filling in, the chart is alive. Don't touch anything for 2 seconds, then hover over the live host.

**Text overlay:** *(none — let the UI speak)*

**Why:** Hook. Something is already happening. Don't start with a blank screen.

---

### Scene 2 — Ping dashboard (4–12s)
**Action:**
1. Click the "Ping" button → watch the diagnostic console animate in (2s)
2. Slowly scroll through the latency chart so bars are visible
3. Hover over the VPN banner (if visible) or the latency number

**Text overlay (top-left, fade in at 5s):**
> `Ping any IP or hostname`
> `Real-time latency · VPN detection · Smart diagnostics`

---

### Scene 3 — Switch to SSH (12–18s)
**Action:**
1. Click the **SSH button** in the top bar of the host detail view
2. The SSH connect modal appears — let it sit for 1 second (credentials pre-filled)
3. Click **Connect**

**Text overlay:**
> `One-click SSH — built in`

---

### Scene 4 — Terminal working (18–32s)
**Action:**
1. Terminal connects — "[Connected]" message appears
2. Type: `ls -la` → hit Enter → output appears
3. Type the first 3 letters of a command that has a ghost suggestion (e.g. `doc`) → pause 0.5s so the ghost text is visible
4. Press **Tab** → ghost completes to `docker ps` → hit Enter
5. Let the docker output scroll for 1 second

**Text overlay (at step 3, when ghost text appears):**
> `History-powered autosuggestions`
> `Tab to complete`

**Why:** This is the "wow" moment. Ghost text appearing and completing is visually striking.

---

### Scene 5 — Multi-terminal (32–40s)
**Action:**
1. Click **+** in the terminal tab bar → new terminal opens and connects instantly
2. Rename it: double-click the tab name → type "logs" → Enter
3. Type `tail -f /var/log/syslog` in the new terminal
4. Click back to the first terminal — it's still exactly where you left it

**Text overlay:**
> `Multiple terminals. All persistent.`

---

### Scene 6 — SFTP file browser (40–52s)
**Action:**
1. Click the **Files** tab
2. Navigate into a folder (one click)
3. Hover over a file → the download button appears → click it
4. Click the **upload** button → pick a file from Finder → it appears in the transfer queue briefly

**Text overlay:**
> `Built-in SFTP`
> `Browse · Download · Upload`

---

### Scene 7 — Command history (52–60s)
**Action:**
1. Click the **History** tab
2. Scroll through briefly — tool groups visible (git, docker, etc.)
3. Click one row → it runs in the terminal (switch back to terminal tab to show it execute)

**Text overlay:**
> `Every command saved. Never lose your bash history again.`

---

### Scene 8 — End card (60–70s)
**Action:** Zoom out to show the full app. Stay still for 3 seconds.

**Text overlay (centre, large):**
> **Pingnet**
> Open source · Built with Tauri + Rust
> `github.com/[your-handle]/pingnet`

**Fade to black.**

---

## Editing tips

- **Speed ramp** scenes 3–5 slightly (1.2–1.4× speed) to keep pace up
- Add **subtle zoom-in punch** (Ken Burns) when ghost text appears — draws the eye
- **Captions on every text overlay** — 60%+ of LinkedIn videos are watched muted
- Keep cuts **snappy** — max 2s of static content anywhere
- **No intro logo card** — start on the live UI immediately

---

## Music

LinkedIn works best with **electronic / lo-fi / ambient** — something that feels modern and focused without being distracting.

### Recommended tracks (royalty-free, free to use)

| Track | Artist | Source | Vibe |
|-------|--------|--------|------|
| "Elevate" | Scott Buckley | scottbuckley.com.au | Cinematic, builds |
| "Chill Abstract Intention" | Coma-Media | Pixabay | Lo-fi electronic |
| "Technology" | Lexin Music | Pixabay | Clean tech energy |
| "Inspiring Cinematic" | LesFM | Pixabay | Forward momentum |
| "Digital Horizon" | Various | Uppbeat.io (free tier) | Developer vibe |

**Pixabay** (pixabay.com/music) — 100% free, no attribution needed, huge library. Search: `technology`, `electronic`, `corporate modern`.

**Uppbeat** (uppbeat.io) — free tier, attribution in video description.

**Tip:** Start music 1 second before the video opens so it's already in flow. Fade out at the end card.

---

## Tools

| Task | Tool | Notes |
|------|------|-------|
| Screen recording | QuickTime (macOS) | File → New Screen Recording |
| Editing | **CapCut** (free) | Great for text overlays + speed ramp |
| Editing | DaVinci Resolve (free) | More control, steeper learning curve |
| Editing | iMovie | Simple, fine for this length |
| Captions | CapCut auto-captions | One click, surprisingly accurate |
| Thumbnail | Figma or Canva | For LinkedIn preview frame |

---

## LinkedIn post caption

Copy and adapt:

```
I built Pingnet — an open-source network diagnostics tool for developers.

What it does:
→ Ping any host with real-time latency charts + VPN detection
→ Embedded SSH terminal (no switching to another app)
→ SFTP file browser built in
→ Persistent command history that survives disconnects
→ Fish-style autosuggestions from your own history

Built with Tauri 2 + Rust + React. Runs on macOS and Linux.

Everything is open source 👇
github.com/[your-handle]/pingnet

#opensource #devtools #rust #tauri #networking #sysadmin #developer
```

**Hook variants to test:**
- *"I got tired of switching between ping, ssh, and FileZilla. So I built one app that does all three."*
- *"Bash history is terrible. So I fixed it."*
- *"Built an open-source SSH client with a feature I've wanted for years — history that never disappears."*

---

## Recording checklist

- [ ] App running with real data (not empty state)
- [ ] SSH pre-configured (no typing passwords on camera)
- [ ] History panel has 6+ entries
- [ ] SFTP has files to browse
- [ ] Dock/taskbar hidden
- [ ] Notifications off (Do Not Disturb on)
- [ ] Mouse cursor is clean and moves slowly/deliberately
- [ ] 1080p or 1440p screen resolution
- [ ] QuickTime / OBS open and ready
- [ ] Music downloaded
```
