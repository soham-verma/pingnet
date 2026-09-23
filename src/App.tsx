import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { newId } from "./utils/id";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, currentMonitor, PhysicalPosition } from "@tauri-apps/api/window";
import { HostConfig, HostFolder, HostState, SshConfig } from "./types";
import { moveHost, moveFolder, deleteFolder, normalizeOrder, effectiveFolderId } from "./utils/hostOrder";
import { usePing, PingSession } from "./hooks/usePing";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useTheme } from "./hooks/useTheme";
import Sidebar from "./components/Sidebar";
import HostDetailView from "./components/HostDetailView";
import DashboardView from "./components/DashboardView";
import AddEditModal from "./components/AddEditModal";
import SSHSessionView from "./components/ssh/SSHSessionView";
import Speedtest from "./components/ssh/Speedtest";
import LocalTerminalView from "./components/LocalTerminalView";
import KeyManager from "./components/KeyManager";
import UpdateModal from "./components/UpdateModal";
import ShortcutsModal from "./components/ShortcutsModal";

function genId(): string {
  // newId(): crypto.randomUUID with a getRandomValues fallback for older WebKit
  // and produces a proper RFC 4122 UUID, unlike Math.random which has ~51 bits of
  // entropy and can collide on bulk imports.
  return newId();
}

function toHostState(config: HostConfig): HostState {
  return {
    ...config,
    ping_status: "idle",
    last_result: null,
    last_pinged_at: null,
    vpn_at_time_of_failure: null,
  };
}

type ViewMode = "ping" | "ssh" | "dashboard";

// Prefill value passed from Dashboard's connect bar into the Add Host modal
type AddHostPrefill = { ip: string } | null;

export default function App() {
  const [hosts, setHosts] = useState<HostState[]>([]);
  const [folders, setFolders] = useState<HostFolder[]>([]);
  // Storage problems shown to the user (damaged files recovered, failed saves)
  const [notices, setNotices] = useState<{ id: string; kind: "warning" | "error"; text: string }[]>([]);
  const pushNotice = useCallback((kind: "warning" | "error", text: string) => {
    setNotices((prev) => prev.some((n) => n.text === text) ? prev : [...prev, { id: newId(), kind, text }]);
  }, []);
  // Set when hosts.json / folders.json could not be READ. Saving would then
  // overwrite data we never loaded, so persistence is blocked until restart.
  const saveBlockedRef = useRef<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: "add" | "edit"; host?: HostState; prefill?: AddHostPrefill } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("dashboard");
  const [sshConfigs, setSshConfigs] = useState<Record<string, SshConfig>>({});
  const [showKeyManager, setShowKeyManager] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showLocalTerminal, setShowLocalTerminal] = useState(false);
  const [showLocalSpeedtest, setShowLocalSpeedtest] = useState(false);
  // Track every host that has ever had SSH opened this session so we can keep
  // their SSHSessionView mounted (and connections alive) while browsing other hosts.
  const [sshOpenedIds, setSshOpenedIds] = useState<Set<string>>(new Set());
  // Last screen (ping / ssh) the user was on for each host, so re-selecting a
  // host from the sidebar or dashboard returns there instead of always Ping.
  const [lastViewByHost, setLastViewByHost] = useState<Record<string, "ping" | "ssh">>({});
  useTheme();
  const update = useUpdateCheck();

  // Auto-open the update modal once when an update is discovered
  useEffect(() => {
    if (update.available && !update.skipped) setShowUpdateModal(true);
  }, [update.available, update.skipped]);

  // BUG-05 fix: prevent the window from being dragged off-screen when the user
  // grabs the bottom-right corner and pulls it past the window's own left edge.
  // macOS correctly clamps the window *width* to minWidth, but repositions the
  // window frame so the right edge stays fixed — which can push the left side
  // (and the entire sidebar) off-screen.  We listen to the resize event and
  // clamp x/y to keep every corner visible.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await win.onResized(async () => {
        try {
          const [pos, size, monitor] = await Promise.all([
            win.outerPosition(),
            win.outerSize(),
            currentMonitor(),
          ]);
          if (!monitor) return;

          const { x: mx, y: my } = monitor.position;
          const { width: mw, height: mh } = monitor.size;

          // Ensure the window stays within the monitor's physical bounds.
          // Leave at least 50 px of the window visible on every edge.
          const margin = 50;
          const clampedX = Math.min(Math.max(pos.x, mx), mx + mw - margin);
          const clampedY = Math.min(Math.max(pos.y, my), my + mh - margin);

          if (clampedX !== pos.x || clampedY !== pos.y) {
            await win.setPosition(new PhysicalPosition(clampedX, clampedY));
          }
        } catch {
          // Ignore — window positioning is best-effort
        }
      });
    })();

    return () => { unlisten?.(); };
  }, []);

  // Memoize the HostConfig array so usePing's useEffect only re-runs when
  // the hosts list actually changes — not on every render caused by session
  // state updates. Without this, every ping result re-renders App, creates a
  // new array reference, and resets all 30 s auto-ping intervals immediately.
  const hostConfigs = useMemo(() => hosts.map((h) => ({
    id: h.id,
    hostname: h.hostname,
    ip: h.ip,
    ip_type: h.ip_type,
    extra_ips: h.extra_ips,
    notes: h.notes,
    created_at: h.created_at,
    alert_on_down: h.alert_on_down,
    alert_on_recovery: h.alert_on_recovery,
    alert_latency_ms: h.alert_latency_ms,
    ssh_port: h.ssh_port,
    ssh_username: h.ssh_username,
    ssh_auth_type: h.ssh_auth_type,
    ssh_key_path: h.ssh_key_path,
    ssh_key_name: h.ssh_key_name,
  })), [hosts]);

  // Pass hosts to usePing so it can schedule auto-ping for hosts with alerts
  const { getSession, ping, stopPing, clearSession } = usePing(hostConfigs);

  // Build sessions map for sidebar
  const allSessions: Record<string, PingSession> = {};
  hosts.forEach((h) => { allSessions[h.id] = getSession(h.id); });

  const selectedHost = hosts.find((h) => h.id === selectedId) ?? null;
  const selectedSession = selectedId ? getSession(selectedId) : null;

  // ── Global keyboard shortcuts ─────────────────────────────────────────────
  // Placed after selectedHost / stopPing declarations to avoid TDZ errors.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      const isTyping = ["input", "textarea", "select"].includes(tag)
        || (document.activeElement as HTMLElement)?.isContentEditable;
      if (isTyping) return;

      // ? — toggle shortcuts cheatsheet
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }

      // If any modal is open, don't fire navigation shortcuts
      if (showShortcuts || showKeyManager || showUpdateModal || modal) return;

      // N — add new host
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setModal({ mode: "add" });
        return;
      }

      // E — edit selected host
      if ((e.key === "e" || e.key === "E") && selectedHost) {
        e.preventDefault();
        setModal({ mode: "edit", host: selectedHost });
        return;
      }

      // S — open SSH for selected host
      if ((e.key === "s" || e.key === "S") && selectedHost) {
        e.preventDefault();
        handleOpenSSH(selectedHost.id);
        return;
      }

      // Enter — ping selected host
      if (e.key === "Enter" && selectedHost && viewMode === "ping") {
        e.preventDefault();
        handlePing(selectedHost);
        return;
      }

      // Esc — stop pinging selected host
      if (e.key === "Escape" && selectedHost) {
        stopPing(selectedHost.id);
        return;
      }

      // Hosts visible in the sidebar (skip those inside collapsed folders)
      const navHosts = hosts.filter((h) => {
        const fid = effectiveFolderId(h, folders);
        return !fid || !folders.find((f) => f.id === fid)?.collapsed || h.id === selectedId;
      });

      // ↑ / ↓ — navigate host list
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const idx = navHosts.findIndex((h) => h.id === selectedId);
        const next = e.key === "ArrowUp"
          ? Math.max(0, idx - 1)
          : Math.min(navHosts.length - 1, idx + 1);
        if (navHosts[next]) handleSelectHost(navHosts[next].id);
        return;
      }

      // 1–9 — jump to host by position
      if (e.key >= "1" && e.key <= "9" && !e.metaKey && !e.ctrlKey) {
        const idx = parseInt(e.key, 10) - 1;
        if (navHosts[idx]) { e.preventDefault(); handleSelectHost(navHosts[idx].id); }
        return;
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [hosts, folders, selectedId, selectedHost, viewMode, modal, showShortcuts, showKeyManager, showUpdateModal, stopPing, lastViewByHost, sshOpenedIds]);

  // Load hosts on mount — also seed sshConfigs from any persisted SSH fields
  useEffect(() => {
    type Loaded<T> = { items: T[]; warning: string | null };
    Promise.all([
      invoke<Loaded<HostConfig>>("load_hosts"),
      invoke<Loaded<HostFolder>>("load_folders"),
    ])
      .then(([hostsRes, foldersRes]) => {
        const configs = hostsRes.items;
        const loadedFolders = foldersRes.items;
        if (hostsRes.warning) pushNotice("warning", hostsRes.warning);
        if (foldersRes.warning) pushNotice("warning", foldersRes.warning);
        setFolders(loadedFolders);
        const states = normalizeOrder(configs.map(toHostState), loadedFolders);
        setHosts(states);
        if (states.length > 0) setSelectedId(states[0].id);
        // Restore saved SSH config for each host (no passwords — never stored)
        const restored: Record<string, SshConfig> = {};
        configs.forEach((c) => {
          if (c.ssh_username) {
            restored[c.id] = {
              port: c.ssh_port ?? 22,
              username: c.ssh_username,
              auth_type: (c.ssh_auth_type as SshConfig["auth_type"]) ?? "password",
              key_path: c.ssh_key_path,
              key_name: c.ssh_key_name,
            };
          }
        });
        if (Object.keys(restored).length > 0) setSshConfigs(restored);
      })
      .catch((e) => {
        // A missing file loads as empty (first launch), so reaching here means
        // an existing file could not be read. Don't let a later save clobber it.
        saveBlockedRef.current = String(e);
        pushNotice("error", `Couldn't read your saved devices (${String(e)}). Changes won't be saved until this is fixed and Pingnet is restarted.`);
      });
  }, []);

  const persistHosts = useCallback(async (updated: HostState[]) => {
    const configs: HostConfig[] = updated.map(
      ({ hostname, ip, ip_type, extra_ips, notes, id, created_at,
         alert_on_down, alert_on_recovery, alert_latency_ms,
         ssh_port, ssh_username, ssh_auth_type, ssh_key_path, ssh_key_name, folder_id }) => ({
        id, hostname, ip, ip_type, extra_ips, notes, created_at,
        alert_on_down, alert_on_recovery, alert_latency_ms,
        ssh_port, ssh_username, ssh_auth_type, ssh_key_path, ssh_key_name,
        folder_id: folder_id ?? null,
      })
    );
    if (saveBlockedRef.current) return;
    try {
      await invoke("save_hosts", { hosts: configs });
    } catch (e) {
      pushNotice("error", `Couldn't save your devices: ${String(e)}. Recent changes will be lost on restart.`);
    }
  }, [pushNotice]);

  const persistFolders = useCallback(async (updated: HostFolder[]) => {
    if (saveBlockedRef.current) return;
    try {
      await invoke("save_folders", { folders: updated });
    } catch (e) {
      pushNotice("error", `Couldn't save your folders: ${String(e)}. Recent changes will be lost on restart.`);
    }
  }, [pushNotice]);

  // ── Sidebar ordering / folders ────────────────────────────────────────────
  function handleMoveHost(hostId: string, folderId: string | null, beforeId: string | null) {
    const updated = moveHost(hosts, folders, hostId, folderId, beforeId);
    if (updated === hosts) return;
    // Dropping into a collapsed folder expands it so the device stays visible
    const target = folderId ? folders.find((f) => f.id === folderId) : null;
    if (target?.collapsed) {
      const nextFolders = folders.map((f) => (f.id === folderId ? { ...f, collapsed: false } : f));
      setFolders(nextFolders);
      persistFolders(nextFolders);
    }
    setHosts(updated);
    persistHosts(updated);
  }

  function handleMoveFolder(folderId: string, beforeId: string | null) {
    const nextFolders = moveFolder(folders, folderId, beforeId);
    if (nextFolders === folders) return;
    const nextHosts = normalizeOrder(hosts, nextFolders);
    setFolders(nextFolders);
    setHosts(nextHosts);
    persistFolders(nextFolders);
    persistHosts(nextHosts);
  }

  function handleCreateFolder(): string {
    const folder: HostFolder = { id: genId(), name: "New folder", collapsed: false };
    const next = [...folders, folder];
    setFolders(next);
    persistFolders(next);
    return folder.id;
  }

  function handleRenameFolder(folderId: string, name: string) {
    const next = folders.map((f) => (f.id === folderId ? { ...f, name } : f));
    setFolders(next);
    persistFolders(next);
  }

  function handleToggleFolder(folderId: string) {
    const next = folders.map((f) => (f.id === folderId ? { ...f, collapsed: !f.collapsed } : f));
    setFolders(next);
    persistFolders(next);
  }

  function handleDeleteFolder(folderId: string) {
    const r = deleteFolder(hosts, folders, folderId);
    setFolders(r.folders);
    setHosts(r.hosts);
    persistFolders(r.folders);
    persistHosts(r.hosts);
  }

  function handleAddHost(
    data: Pick<HostConfig, "hostname" | "ip" | "ip_type" | "extra_ips" | "notes" | "alert_on_down" | "alert_on_recovery" | "alert_latency_ms">
  ) {
    const newHost: HostState = toHostState({
      ...data,
      id: genId(),
      created_at: Date.now(),
    });
    const updated = [...hosts, newHost];
    setHosts(updated);
    setSelectedId(newHost.id);
    setViewMode("ping");
    setModal(null);
    persistHosts(updated);
  }

  function handleEditHost(
    data: Pick<HostConfig, "hostname" | "ip" | "ip_type" | "extra_ips" | "notes" | "alert_on_down" | "alert_on_recovery" | "alert_latency_ms">
  ) {
    if (!modal?.host) return;
    const updated = hosts.map((h) =>
      h.id === modal.host!.id ? { ...h, ...data } : h
    );
    setHosts(updated);
    setModal(null);
    persistHosts(updated);
  }

  function handleDeleteHost(id: string) {
    const updated = hosts.filter((h) => h.id !== id);
    setHosts(updated);
    clearSession(id);
    setSshOpenedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setModal(null);
    if (selectedId === id) {
      const next = updated[0]?.id ?? null;
      setSelectedId(next);
      setViewMode(next ? "ping" : "dashboard");
    }
    persistHosts(updated);
  }

  function handlePing(host: HostState) {
    ping(host);
  }

  /** Swap which IP is the active ping target for a host.
   *  The current active IP is moved into extra_ips, and the chosen extra IP
   *  becomes the new active `ip`. */
  function handleSetActiveIp(hostId: string, newIp: string, newIpType: HostConfig["ip_type"]) {
    const updated = hosts.map((h) => {
      if (h.id !== hostId) return h;
      const prevExtra = h.extra_ips ?? [];
      // Remove the newly-active IP from extra_ips (if it was there)
      const nextExtra = prevExtra.filter((e) => e.address !== newIp);
      // Push the old active IP into extra_ips (preserve its type)
      if (h.ip && h.ip !== newIp) {
        nextExtra.push({ address: h.ip, type: h.ip_type ?? "other" });
      }
      return { ...h, ip: newIp, ip_type: newIpType, extra_ips: nextExtra };
    });
    setHosts(updated);
    persistHosts(updated);
  }

  /** Show a host in a specific view and remember it as that host's last view. */
  function showHost(id: string, view: "ping" | "ssh") {
    setSelectedId(id);
    setViewMode(view);
    setLastViewByHost((prev) => (prev[id] === view ? prev : { ...prev, [id]: view }));
    setShowLocalTerminal(false);
    setShowLocalSpeedtest(false);
  }

  function handleOpenSSH(id: string) {
    setSshOpenedIds((prev) => new Set([...prev, id]));
    showHost(id, "ssh");
  }

  function handleOpenPing(id: string) {
    showHost(id, "ping");
  }

  /** Selecting a host restores the screen the user was last on for it — the
   *  SSH view if its session was opened and left on SSH, otherwise Ping. */
  function handleSelectHost(id: string) {
    const view = lastViewByHost[id] === "ssh" && sshOpenedIds.has(id) ? "ssh" : "ping";
    showHost(id, view);
  }

  function handleOpenUpdate() {
    setShowUpdateModal(true);
    // Re-check on demand so the modal reflects the server's current state
    if (!update.available && !update.checking) update.checkNow();
  }

  function handleGoHome() {
    setViewMode("dashboard");
    setShowLocalTerminal(false);
    setShowLocalSpeedtest(false);
  }

  const showDashboard = !showLocalTerminal && !showLocalSpeedtest && (viewMode === "dashboard" || !selectedHost);

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* Storage notices — damaged-file recovery and failed saves */}
      {notices.length > 0 && (
        <div className="flex-shrink-0 flex flex-col" role="alert">
          {notices.map((n) => (
            <div key={n.id}
              className="flex items-start gap-3 px-4 py-2 text-[12px] border-b"
              style={n.kind === "error"
                ? { background: "#ef444414", borderColor: "#ef444440", color: "#fca5a5" }
                : { background: "#f59e0b14", borderColor: "#f59e0b40", color: "#fcd34d" }}>
              <span className="flex-1 leading-snug break-words">{n.text}</span>
              <button
                onClick={() => setNotices((prev) => prev.filter((x) => x.id !== n.id))}
                className="flex-shrink-0 opacity-70 hover:opacity-100"
                aria-label="Dismiss"
              >✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          hosts={hosts}
          folders={folders}
          selectedId={selectedId}
          sessions={allSessions}
          viewMode={viewMode}
          onSelect={handleSelectHost}
          onOpenPing={handleOpenPing}
          onOpenSSH={handleOpenSSH}
          onMoveHost={handleMoveHost}
          onMoveFolder={handleMoveFolder}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onToggleFolder={handleToggleFolder}
          onOpenKeyManager={() => setShowKeyManager(true)}
          onOpenLocalTerminal={() => { setShowLocalTerminal(true); setShowLocalSpeedtest(false); }}
          onOpenSpeedtest={() => { setShowLocalSpeedtest(true); setShowLocalTerminal(false); }}
          onAddHost={() => setModal({ mode: "add" })}
          localTerminalActive={showLocalTerminal}
          localSpeedtestActive={showLocalSpeedtest}
          currentVersion={update.currentVersion}
          updateAvailable={update.available && !update.skipped}
          onOpenUpdate={handleOpenUpdate}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(v => !v)}
          onGoHome={handleGoHome}
        />

        {/* Main content */}
        <main className="flex-1 overflow-hidden relative">

          {/* ── Dashboard — home view, shown on launch and whenever no host is selected ── */}
          {showDashboard && (
            <div className="absolute inset-0 flex flex-col">
              <DashboardView
                hosts={hosts}
                sessions={allSessions}
                onSelectHost={handleSelectHost}
                onOpenSSH={handleOpenSSH}
                onAddHost={(prefillIp) => setModal({ mode: "add", prefill: prefillIp ? { ip: prefillIp } : null })}
              />
            </div>
          )}

          {/* ── Ping view — shows the selected host's diagnostics ──────────── */}
          {selectedHost && selectedSession && (
            <div
              className="absolute inset-0"
              style={{ display: viewMode === "ping" && !showLocalTerminal && !showLocalSpeedtest ? "flex" : "none", flexDirection: "column" }}
            >
              <HostDetailView
                host={selectedHost}
                session={selectedSession}
                onPing={() => handlePing(selectedHost)}
                onStop={() => stopPing(selectedHost.id)}
                onEdit={() => setModal({ mode: "edit", host: selectedHost })}
                onRefresh={() => clearSession(selectedHost.id)}
                onOpenSSH={() => handleOpenSSH(selectedHost.id)}
                onSetActiveIp={(ip, type) => handleSetActiveIp(selectedHost.id, ip, type)}
              />
            </div>
          )}

          {/* ── SSH sessions — one per opened host, all mounted simultaneously.
               Staying mounted while browsing other hosts keeps connections alive. ── */}
          {hosts.filter((h) => sshOpenedIds.has(h.id)).map((host) => (
            <div
              key={host.id}
              className="absolute inset-0"
              style={{
                display: selectedId === host.id && viewMode === "ssh" && !showLocalTerminal && !showLocalSpeedtest ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              <SSHSessionView
                visible={selectedId === host.id && viewMode === "ssh" && !showLocalTerminal && !showLocalSpeedtest}
                hostname={host.hostname}
                ip={host.ip}
                hostId={host.id}
                savedConfig={sshConfigs[host.id] ?? null}
                onSaveConfig={(config) => {
                  setSshConfigs((prev) => ({ ...prev, [host.id]: config }));
                  setHosts((prev) => {
                    const updated = prev.map((h) =>
                      h.id === host.id
                        ? { ...h,
                            ssh_port: config.port,
                            ssh_username: config.username,
                            ssh_auth_type: config.auth_type,
                            ssh_key_path: config.key_path,
                            ssh_key_name: config.key_name }
                        : h
                    );
                    persistHosts(updated);
                    return updated;
                  });
                }}
              />
            </div>
          ))}

          {/* ── Local terminal overlay ─────────────────────────────────────── */}
          <div
            className="absolute inset-0 flex flex-col"
            style={{ display: showLocalTerminal ? "flex" : "none", zIndex: 20, background: "var(--bg)" }}
          >
            <LocalTerminalView />
          </div>

          {/* ── Local speed test overlay — tests this machine, no host needed ── */}
          <div
            className="absolute inset-0 flex flex-col"
            style={{ display: showLocalSpeedtest ? "flex" : "none", zIndex: 20, background: "var(--bg)" }}
          >
            <Speedtest sessionId={null} isActive={showLocalSpeedtest} mode="local" />
          </div>

        </main>

        {/* Add/Edit modal */}
        {modal && (
          <AddEditModal
            existing={modal.mode === "edit" ? modal.host : null}
            initialIp={modal.prefill?.ip}
            onSave={modal.mode === "add" ? handleAddHost : handleEditHost}
            onClose={() => setModal(null)}
            onDelete={modal.mode === "edit" && modal.host ? () => handleDeleteHost(modal.host!.id) : undefined}
          />
        )}

        {/* Key Manager */}
        {showKeyManager && <KeyManager onClose={() => setShowKeyManager(false)} />}

        {/* Update modal */}
        {showUpdateModal && (
          <UpdateModal update={update} onClose={() => setShowUpdateModal(false)} />
        )}

        {/* Shortcuts cheatsheet */}
        {showShortcuts && (
          <ShortcutsModal onClose={() => setShowShortcuts(false)} />
        )}
      </div>
    </div>
  );
}
