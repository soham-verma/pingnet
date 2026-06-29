import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, currentMonitor, PhysicalPosition } from "@tauri-apps/api/window";
import { HostConfig, HostState, SshConfig } from "./types";
import { usePing, PingSession } from "./hooks/usePing";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { useTheme } from "./hooks/useTheme";
import Sidebar from "./components/Sidebar";
import HostDetailView from "./components/HostDetailView";
import AddEditModal from "./components/AddEditModal";
import SSHSessionView from "./components/ssh/SSHSessionView";
import KeyManager from "./components/KeyManager";
import UpdateModal from "./components/UpdateModal";
import ShortcutsModal from "./components/ShortcutsModal";

function genId(): string {
  // crypto.randomUUID() is available in all Tauri WebView targets (Chromium/WebKit)
  // and produces a proper RFC 4122 UUID, unlike Math.random which has ~51 bits of
  // entropy and can collide on bulk imports.
  return crypto.randomUUID();
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

type ViewMode = "ping" | "ssh";

export default function App() {
  const [hosts, setHosts] = useState<HostState[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: "add" | "edit"; host?: HostState } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("ping");
  const [sshConfigs, setSshConfigs] = useState<Record<string, SshConfig>>({});
  const [showKeyManager, setShowKeyManager] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, toggleTheme] = useTheme();
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

      // ↑ / ↓ — navigate host list
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const idx = hosts.findIndex((h) => h.id === selectedId);
        const next = e.key === "ArrowUp"
          ? Math.max(0, idx - 1)
          : Math.min(hosts.length - 1, idx + 1);
        if (hosts[next]) { setSelectedId(hosts[next].id); setViewMode("ping"); }
        return;
      }

      // 1–9 — jump to host by position
      if (e.key >= "1" && e.key <= "9" && !e.metaKey && !e.ctrlKey) {
        const idx = parseInt(e.key, 10) - 1;
        if (hosts[idx]) { e.preventDefault(); setSelectedId(hosts[idx].id); setViewMode("ping"); }
        return;
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [hosts, selectedId, selectedHost, viewMode, modal, showShortcuts, showKeyManager, showUpdateModal, stopPing]);

  // Load hosts on mount — also seed sshConfigs from any persisted SSH fields
  useEffect(() => {
    invoke<HostConfig[]>("load_hosts")
      .then((configs) => {
        const states = configs.map(toHostState);
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
      .catch(() => {
        // First launch or error — start empty
      });
  }, []);

  const persistHosts = useCallback(async (updated: HostState[]) => {
    const configs: HostConfig[] = updated.map(
      ({ hostname, ip, ip_type, extra_ips, notes, id, created_at,
         alert_on_down, alert_on_recovery, alert_latency_ms,
         ssh_port, ssh_username, ssh_auth_type, ssh_key_path, ssh_key_name }) => ({
        id, hostname, ip, ip_type, extra_ips, notes, created_at,
        alert_on_down, alert_on_recovery, alert_latency_ms,
        ssh_port, ssh_username, ssh_auth_type, ssh_key_path, ssh_key_name,
      })
    );
    try {
      await invoke("save_hosts", { hosts: configs });
    } catch (e) {
      // Surface write failures — silent data loss is worse than a console error
      console.error("[Pingnet] Failed to persist hosts:", e);
    }
  }, []);

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
    setModal(null);
    if (selectedId === id) {
      setSelectedId(updated[0]?.id ?? null);
      setViewMode("ping");
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

  function handleSelectHost(id: string) {
    setSelectedId(id);
    setViewMode("ping");
  }

  function handleOpenSSH(id: string) {
    setSelectedId(id);
    setViewMode("ssh");
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: "var(--bg)" }}>
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          hosts={hosts}
          selectedId={selectedId}
          sessions={allSessions}
          viewMode={viewMode}
          onSelect={handleSelectHost}
          onOpenSSH={handleOpenSSH}
          onAddHost={() => setModal({ mode: "add" })}
          onOpenKeyManager={() => setShowKeyManager(true)}
          onOpenShortcuts={() => setShowShortcuts(true)}
          currentVersion={update.currentVersion}
          updateAvailable={update.available && !update.skipped}
          onOpenUpdate={() => setShowUpdateModal(true)}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(v => !v)}
          theme={theme}
          onToggleTheme={toggleTheme}
        />

        {/* Main content */}
        <main className="flex-1 overflow-hidden relative">
          {!selectedHost && <EmptyState onAdd={() => setModal({ mode: "add" })} />}

          {selectedHost && selectedSession && (
            <>
              {/* Ping view */}
              <div
                className="absolute inset-0"
                style={{ display: viewMode === "ping" ? "flex" : "none", flexDirection: "column" }}
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

              {/* SSH view */}
              <div
                className="absolute inset-0"
                style={{ display: viewMode === "ssh" ? "flex" : "none", flexDirection: "column" }}
              >
                <SSHSessionView
                  key={selectedHost.id}
                  hostname={selectedHost.hostname}
                  ip={selectedHost.ip}
                  hostId={selectedHost.id}
                  savedConfig={sshConfigs[selectedHost.id] ?? null}
                  onSaveConfig={(config) => {
                    setSshConfigs((prev) => ({ ...prev, [selectedHost.id]: config }));
                    // Persist SSH config (no password) into the host record so it survives restarts
                    setHosts((prev) => {
                      const updated = prev.map((h) =>
                        h.id === selectedHost.id
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
            </>
          )}
        </main>

        {/* Add/Edit modal */}
        {modal && (
          <AddEditModal
            existing={modal.mode === "edit" ? modal.host : null}
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

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <div className="relative mb-8">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "var(--bg3)" }}>
          <svg width="44" height="44" viewBox="0 0 200 200" fill="none">
            <path d="M 80,148 L 80,64 C 80,44 96,36 112,36 C 138,36 148,60 148,86 C 148,110 132,124 110,124 L 90,124"
              stroke="#00c8a8" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="80" cy="148" r="10" fill="#00c8a8"/>
          </svg>
        </div>
      </div>

      <h2 className="text-xl font-semibold text-[var(--text)] mb-2">No Host Selected</h2>
      <p className="text-[var(--text3)] text-sm max-w-xs mb-6">
        Add a device to start monitoring. You can ping any IP address or hostname and get detailed diagnostics.
      </p>
      <button
        onClick={onAdd}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-[var(--text)] bg-[#6366f1] hover:bg-[#818cf8] transition-colors"
      >
        <span className="text-base leading-none">+</span>
        Add your first host
      </button>
    </div>
  );
}
