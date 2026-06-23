import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HostConfig, HostState, SshConfig } from "./types";
import { usePing, PingSession } from "./hooks/usePing";
import Sidebar from "./components/Sidebar";
import HostDetailView from "./components/HostDetailView";
import AddEditModal from "./components/AddEditModal";
import SSHSessionView from "./components/ssh/SSHSessionView";

function genId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toHostState(config: HostConfig): HostState {
  return { ...config, ping_status: "idle", last_result: null, last_pinged_at: null, vpn_at_time_of_failure: null };
}

type ViewMode = "ping" | "ssh";

export default function App() {
  const [hosts, setHosts] = useState<HostState[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: "add" | "edit"; host?: HostState } | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("ping");
  // SSH config per host (username, port, auth_type saved but not password)
  const [sshConfigs, setSshConfigs] = useState<Record<string, SshConfig>>({});

  const { getSession, ping, clearSession } = usePing();

  // Build sessions map for sidebar
  const allSessions: Record<string, PingSession> = {};
  hosts.forEach((h) => { allSessions[h.id] = getSession(h.id); });

  const selectedHost = hosts.find((h) => h.id === selectedId) ?? null;
  const selectedSession = selectedId ? getSession(selectedId) : null;

  // Load hosts on mount
  useEffect(() => {
    invoke<HostConfig[]>("load_hosts")
      .then((configs) => {
        const states = configs.map(toHostState);
        setHosts(states);
        if (states.length > 0) setSelectedId(states[0].id);
      })
      .catch(() => {
        // First launch or error — start empty
      });
  }, []);

  const persistHosts = useCallback(async (updated: HostState[]) => {
    const configs: HostConfig[] = updated.map(({ hostname, ip, notes, id, created_at }) => ({
      id, hostname, ip, notes, created_at,
    }));
    try {
      await invoke("save_hosts", { hosts: configs });
    } catch {
      // Non-fatal
    }
  }, []);

  function handleAddHost(data: Pick<HostConfig, "hostname" | "ip" | "notes">) {
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

  function handleEditHost(data: Pick<HostConfig, "hostname" | "ip" | "notes">) {
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
    <div className="flex h-screen overflow-hidden" style={{ background: "#08080f" }}>
      {/* Sidebar */}
      <Sidebar
        hosts={hosts}
        selectedId={selectedId}
        sessions={allSessions}
        viewMode={viewMode}
        onSelect={handleSelectHost}
        onOpenSSH={handleOpenSSH}
        onAddHost={() => setModal({ mode: "add" })}
      />

      {/* Main content */}
      <main className="flex-1 overflow-hidden relative">
        {!selectedHost && <EmptyState onAdd={() => setModal({ mode: "add" })} />}

        {/*
          Both Ping and SSH views are always mounted for the selected host.
          display:none keeps them alive so switching between them loses no state:
          - Ping: preserves latency history, chart, console logs
          - SSH: preserves open terminals, SFTP path, transfer queue
          Switching hosts (selectedId changes) re-mounts via React's key logic.
        */}
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
                onSaveConfig={(config) =>
                  setSshConfigs((prev) => ({ ...prev, [selectedHost.id]: config }))
                }
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
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <div className="relative mb-8">
        <div className="w-16 h-16 rounded-full border border-[#1e1e35] flex items-center justify-center" style={{ background: "#0f0f1a" }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <circle cx="14" cy="14" r="4" fill="#00c8a8" fillOpacity="0.8" />
            <circle cx="14" cy="14" r="8" stroke="#00c8a8" strokeWidth="1" strokeOpacity="0.3" />
            <circle cx="14" cy="14" r="12" stroke="#00c8a8" strokeWidth="1" strokeOpacity="0.1" />
          </svg>
        </div>
      </div>

      <h2 className="text-xl font-semibold text-white mb-2">No Host Selected</h2>
      <p className="text-[#4b5563] text-sm max-w-xs mb-6">
        Add a device to start monitoring. You can ping any IP address or hostname and get detailed diagnostics.
      </p>
      <button
        onClick={onAdd}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-white bg-[#6366f1] hover:bg-[#818cf8] transition-colors"
      >
        <span className="text-base leading-none">+</span>
        Add your first host
      </button>
    </div>
  );
}
