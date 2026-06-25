import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const update = useUpdateCheck();

  // Auto-open the update modal once when an update is discovered
  useEffect(() => {
    if (update.available && !update.skipped) setShowUpdateModal(true);
  }, [update.available, update.skipped]);

  // Pass hosts to usePing so it can schedule auto-ping for hosts with alerts
  const { getSession, ping, clearSession } = usePing(hosts.map((h) => ({
    id: h.id,
    hostname: h.hostname,
    ip: h.ip,
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
  })));

  // Build sessions map for sidebar
  const allSessions: Record<string, PingSession> = {};
  hosts.forEach((h) => { allSessions[h.id] = getSession(h.id); });

  const selectedHost = hosts.find((h) => h.id === selectedId) ?? null;
  const selectedSession = selectedId ? getSession(selectedId) : null;

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
      ({ hostname, ip, notes, id, created_at,
         alert_on_down, alert_on_recovery, alert_latency_ms,
         ssh_port, ssh_username, ssh_auth_type, ssh_key_path, ssh_key_name }) => ({
        id, hostname, ip, notes, created_at,
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
    data: Pick<HostConfig, "hostname" | "ip" | "notes" | "alert_on_down" | "alert_on_recovery" | "alert_latency_ms">
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
    data: Pick<HostConfig, "hostname" | "ip" | "notes" | "alert_on_down" | "alert_on_recovery" | "alert_latency_ms">
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
                  onEdit={() => setModal({ mode: "edit", host: selectedHost })}
                  onRefresh={() => clearSession(selectedHost.id)}
                  onOpenSSH={() => handleOpenSSH(selectedHost.id)}
                />
              </div>

              {/* SSH view */}
              <div
                className="absolute inset-0"
                style={{ display: viewMode === "ssh" ? "flex" : "none", flexDirection: "column" }}
              >
                <SSHSessionView
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
