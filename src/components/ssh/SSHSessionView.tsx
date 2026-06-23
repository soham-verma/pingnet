import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SshConfig, SshConnectionStatus, TransferItem, PingResult, CommandEntry } from "../../types";
import SSHConnectModal from "./SSHConnectModal";
import SSHTerminal from "./SSHTerminal";
import SFTPBrowser from "./SFTPBrowser";
import TransferQueue from "./TransferQueue";
import CommandHistory from "./CommandHistory";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TerminalTab {
  id: string;
  name: string;
  status: SshConnectionStatus;
  error: string | null;
}

interface StoredCreds {
  config: SshConfig;
  password: string;
}

interface Props {
  hostname: string;
  ip: string;
  hostId: string;
  savedConfig: SshConfig | null;
  onSaveConfig: (config: SshConfig) => void;
}

type ViewTab = "terminal" | "files" | "transfers" | "history";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function defaultName(existing: TerminalTab[]): string {
  return `Terminal ${existing.length + 1}`;
}

function statusColor(s: SshConnectionStatus): string {
  switch (s) {
    case "connected":      return "#22c55e";
    case "checking":
    case "connecting":     return "#f59e0b";
    case "preflight_fail":
    case "ssh_fail":
    case "lost":           return "#ef4444";
    default:               return "#374151";
  }
}

function isTransient(s: SshConnectionStatus): boolean {
  return s === "checking" || s === "connecting";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SSHSessionView({
  hostname,
  ip,
  hostId: _hostId,
  savedConfig,
  onSaveConfig,
}: Props) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<ViewTab>("terminal");
  const [storedCreds, setStoredCreds] = useState<StoredCreds | null>(null);
  const [showModal, setShowModal] = useState(false);
  const pendingTabId = useRef<string | null>(null);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [commands, setCommands] = useState<CommandEntry[]>([]);

  // Inline rename
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Per-tab connection-loss unlisten functions
  const unlistenMap = useRef<Map<string, () => void>>(new Map());

  // ── Tab status helper ──────────────────────────────────────────────────────

  const setTabStatus = (id: string, status: SshConnectionStatus, error: string | null) =>
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, status, error } : t));

  // ── Command history ───────────────────────────────────────────────────────

  /** Called by SSHTerminal whenever the user submits a command (presses Enter). */
  const handleCommand = useCallback(async (cmd: string) => {
    const base = cmd.trim().split(/\s+/)[0] ?? "";
    if (!base) return;

    const isNewBase = await invoke<boolean>("save_command", {
      host: ip,
      command: cmd.trim(),
      helpSummary: null,
    }).catch(() => false);

    setCommands(prev => {
      const ts = Date.now();
      const idx = prev.findIndex(c => c.command === cmd.trim());
      if (idx !== -1) {
        // Bump existing entry to top, increment count
        const updated = { ...prev[idx], count: prev[idx].count + 1, last_seen: ts };
        return [updated, ...prev.filter((_, i) => i !== idx)];
      }
      // New command entry
      const entry: CommandEntry = {
        command: cmd.trim(),
        base_cmd: base,
        count: 1,
        first_seen: ts,
        last_seen: ts,
        help_summary: null,
      };
      return [entry, ...prev];
    });

    // Toast for brand-new tools — briefly highlight the History tab
    if (isNewBase) {
      setNewToolFlash(base);
      setTimeout(() => setNewToolFlash(null), 3000);
    }
  }, [ip]);

  const [newToolFlash, setNewToolFlash] = useState<string | null>(null);

  // Load persisted history when the first connection goes live
  const historyLoadedRef = useRef(false);
  useEffect(() => {
    const anyConnected = tabs.some(t => t.status === "connected");
    if (anyConnected && !historyLoadedRef.current) {
      historyLoadedRef.current = true;
      invoke<CommandEntry[]>("load_command_history", { host: ip })
        .then(setCommands)
        .catch(() => {});
    }
  }, [tabs, ip]);

  // Suggestions for ghost-text: just the command strings, most-recent first
  const suggestions = commands.map(c => c.command);

  // ── Transfer listener ─────────────────────────────────────────────────────

  useEffect(() => {
    const unlisten = listen<{
      id: string; name: string; kind: string;
      bytes_done: number; total_bytes: number; status: string; error?: string;
    }>("transfer-progress", (event) => {
      const p = event.payload;
      setTransfers((prev) => {
        const idx = prev.findIndex((t) => t.id === p.id);
        const item: TransferItem = {
          id: p.id, name: p.name,
          kind: p.kind as "upload" | "download",
          bytes_done: p.bytes_done, total_bytes: p.total_bytes,
          status: p.status as TransferItem["status"], error: p.error,
        };
        if (idx === -1) return [...prev, item];
        const next = [...prev]; next[idx] = item; return next;
      });
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // ── Cleanup all listeners on unmount ─────────────────────────────────────

  useEffect(() => {
    return () => {
      unlistenMap.current.forEach((fn) => fn());
      unlistenMap.current.clear();
    };
  }, []);

  // ── Rename ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (editingId) renameInputRef.current?.select();
  }, [editingId]);

  const startRename = (tab: TerminalTab) => {
    setEditingId(tab.id); setEditingName(tab.name);
  };

  const commitRename = () => {
    if (!editingId) return;
    setTabs((prev) =>
      prev.map((t) => t.id === editingId ? { ...t, name: editingName.trim() || t.name } : t)
    );
    setEditingId(null);
  };

  // ── Pre-flight ping ───────────────────────────────────────────────────────

  /**
   * Quick ICMP ping before SSH — uses the existing ping_host command.
   * Returns true if reachable, false + an error string if not.
   * Fails open (returns true) if the ping command itself errors, so a firewall
   * blocking ICMP doesn't permanently block SSH.
   */
  const preflight = async (tabId: string): Promise<{ ok: boolean; detail: string | null }> => {
    setTabStatus(tabId, "checking", null);
    try {
      const result = await invoke<PingResult>("ping_host", { ip });
      if (result.success) return { ok: true, detail: null };
      return { ok: false, detail: result.error_detail ?? "Host did not respond to ping" };
    } catch {
      // ping command error — don't block SSH over this
      return { ok: true, detail: null };
    }
  };

  // ── Connection-loss listener ──────────────────────────────────────────────

  const registerLostListener = async (tabId: string) => {
    // Clean up any previous listener for this tab
    unlistenMap.current.get(tabId)?.();

    const unlisten = await listen(`ssh-closed-${tabId}`, () => {
      setTabStatus(tabId, "lost", "Connection dropped unexpectedly");
    });
    unlistenMap.current.set(tabId, unlisten);
  };

  // ── Connect (with pre-flight) ─────────────────────────────────────────────

  const connectTab = async (tabId: string, creds: StoredCreds, skipPreflight = false) => {
    // 1. Pre-flight ping (unless caller opts out, e.g. "Try anyway")
    if (!skipPreflight) {
      const { ok, detail } = await preflight(tabId);
      if (!ok) {
        setTabStatus(tabId, "preflight_fail", detail);
        return;
      }
    }

    // 2. SSH connect
    setTabStatus(tabId, "connecting", null);
    try {
      const authArg =
        creds.config.auth_type === "password"
          ? { type: "Password", password: creds.password }
          : { type: "Key", key_path: creds.config.key_path ?? "~/.ssh/id_rsa", passphrase: creds.password || null };

      await invoke("ssh_connect", {
        sessionId: tabId,
        host: ip,
        port: creds.config.port,
        username: creds.config.username,
        auth: authArg,
      });

      setTabStatus(tabId, "connected", null);
      await registerLostListener(tabId);
    } catch (e) {
      setTabStatus(tabId, "ssh_fail", String(e));
    }
  };

  // ── Reconnect (full cycle with preflight) ─────────────────────────────────

  const reconnectTab = (tabId: string) => {
    if (!storedCreds) { setShowModal(true); return; }
    connectTab(tabId, storedCreds);
  };

  // ── Modal submit ──────────────────────────────────────────────────────────

  const handleConnect = async (config: SshConfig, password: string) => {
    setShowModal(false);
    const creds: StoredCreds = { config, password };
    setStoredCreds(creds);
    onSaveConfig(config);

    const tabId = pendingTabId.current ?? activeTabId;
    pendingTabId.current = null;
    if (tabId) await connectTab(tabId, creds);
  };

  // ── Add / open / close tabs ───────────────────────────────────────────────

  const openFirstTab = () => {
    const id = uid();
    setTabs([{ id, name: "Terminal 1", status: "disconnected", error: null }]);
    setActiveTabId(id);
    pendingTabId.current = id;
    setShowModal(true);
  };

  const addTab = () => {
    const id = uid();
    setTabs((prev) => [...prev, { id, name: defaultName(prev), status: "disconnected", error: null }]);
    setActiveTabId(id);
    setViewTab("terminal");

    if (storedCreds) {
      connectTab(id, storedCreds);
    } else {
      pendingTabId.current = id;
      setShowModal(true);
    }
  };

  const closeTab = async (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    unlistenMap.current.get(tabId)?.();
    unlistenMap.current.delete(tabId);
    try { await invoke("ssh_disconnect", { sessionId: tabId }); } catch {}

    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  const connectedTabs = tabs.filter((t) => t.status === "connected");
  const primarySessionId = connectedTabs[0]?.id ?? null;
  const anyConnected = connectedTabs.length > 0;
  const activeTransfers = transfers.filter((t) => t.status === "running").length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-[#1e1e35] flex-shrink-0"
        style={{ background: "#0a0a14" }}>

        <div className="w-6 h-6 flex items-center justify-center rounded-md flex-shrink-0"
          style={{ background: "#6366f115", border: "1px solid #6366f125" }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="0.5" y="1.5" width="11" height="9" rx="1.5" stroke="#818cf8" strokeWidth="1" />
            <path d="M2.5 5.5L4 4L2.5 2.5" stroke="#818cf8" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 5.5H7.5" stroke="#818cf8" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-white font-semibold text-sm">{hostname}</span>
            {anyConnected && (
              <span className="text-[11px] px-2 py-0.5 rounded-full"
                style={{ background: "#22c55e15", color: "#22c55e", border: "1px solid #22c55e25" }}>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#22c55e] mr-1 align-middle" />
                {connectedTabs.length} connected
              </span>
            )}
          </div>
          <div className="text-[11px] text-[#374151] font-mono mt-0.5">
            {storedCreds ? `${storedCreds.config.username}@${ip}:${storedCreds.config.port}` : ip}
          </div>
        </div>

        {/* View tabs */}
        <div className="flex items-center gap-1 bg-[#0f0f1a] rounded-lg p-1 border border-[#1e1e35]">
          {(["terminal", "files", "transfers", "history"] as ViewTab[]).map((t) => (
            <button key={t} onClick={() => setViewTab(t)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all capitalize ${
                viewTab === t ? "bg-[#1e1e35] text-white" : "text-[#4b5563] hover:text-[#8892a4]"
              }`}
            >
              {t}
              {t === "transfers" && activeTransfers > 0 && (
                <span className="w-3.5 h-3.5 flex items-center justify-center rounded-full text-[8px] font-bold bg-[#6366f1] text-white">
                  {activeTransfers}
                </span>
              )}
              {t === "history" && newToolFlash && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#00c8a8] animate-pulse" title={`New tool: ${newToolFlash}`} />
              )}
              {t === "history" && !newToolFlash && commands.length > 0 && (
                <span className="text-[9px] text-[#374151]">{commands.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden relative">

        {/* Terminal panel */}
        <div className="absolute inset-0 flex flex-col"
          style={{ display: viewTab === "terminal" ? "flex" : "none" }}>

          {tabs.length === 0 ? (
            <EmptyTerminalState hostname={hostname} onOpen={openFirstTab} />
          ) : (
            <>
              {/* xterm instances — all kept mounted */}
              <div className="flex-1 relative">
                {tabs.map((tab) => (
                  <div key={tab.id} className="absolute inset-0"
                    style={{ display: tab.id === activeTabId ? "block" : "none", background: "#08080f" }}>
                    <TabContent
                      tab={tab}
                      ip={ip}
                      suggestions={suggestions}
                      onCommand={handleCommand}
                      onRetry={() => storedCreds && connectTab(tab.id, storedCreds)}
                      onRetrySkipPing={() => storedCreds && connectTab(tab.id, storedCreds, true)}
                      onReconnect={() => reconnectTab(tab.id)}
                    />
                  </div>
                ))}
              </div>

              {/* Tab bar */}
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                editingId={editingId}
                editingName={editingName}
                renameInputRef={renameInputRef}
                onActivate={setActiveTabId}
                onClose={closeTab}
                onAdd={addTab}
                onStartRename={startRename}
                onEditChange={setEditingName}
                onCommitRename={commitRename}
                onCancelRename={() => setEditingId(null)}
              />
            </>
          )}
        </div>

        {/* Files panel — mounted once connected, preserved with display:none */}
        {primarySessionId ? (
          <div className="absolute inset-0"
            style={{ display: viewTab === "files" ? "block" : "none" }}>
            <SFTPBrowser
              sessionId={primarySessionId}
              onUploadStart={(id, name, totalBytes) =>
                setTransfers((p) => [...p, { id, name, kind: "upload", bytes_done: 0, total_bytes: totalBytes, status: "running" }])
              }
              onDownloadStart={(id, name) =>
                setTransfers((p) => [...p, { id, name, kind: "download", bytes_done: 0, total_bytes: 0, status: "running" }])
              }
            />
          </div>
        ) : viewTab === "files" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#374151]">
            <p className="text-sm">No active connection</p>
            <p className="text-[12px] text-[#2d3748]">Open a terminal and connect first</p>
          </div>
        ) : null}

        {/* Transfers panel — always mounted */}
        <div className="absolute inset-0"
          style={{ display: viewTab === "transfers" ? "block" : "none" }}>
          <TransferQueue
            transfers={transfers}
            onClear={() => setTransfers((p) => p.filter((t) => t.status === "running"))}
          />
        </div>

        {/* History panel — always mounted */}
        <div className="absolute inset-0"
          style={{ display: viewTab === "history" ? "block" : "none" }}>
          <CommandHistory
            commands={commands}
            activeSessionId={primarySessionId}
          />
        </div>
      </div>

      {showModal && (
        <SSHConnectModal
          hostname={hostname}
          ip={ip}
          savedConfig={savedConfig}
          onConnect={handleConnect}
          onClose={() => {
            setShowModal(false);
            if (pendingTabId.current) {
              const id = pendingTabId.current;
              pendingTabId.current = null;
              setTabs((prev) => {
                const next = prev.filter((t) => t.id !== id);
                if (activeTabId === id) setActiveTabId(next[next.length - 1]?.id ?? null);
                return next;
              });
            }
          }}
        />
      )}
    </div>
  );
}

// ── TabContent ────────────────────────────────────────────────────────────────

interface TabContentProps {
  tab: TerminalTab;
  ip: string;
  suggestions: string[];
  onCommand: (cmd: string) => void;
  onRetry: () => void;
  onRetrySkipPing: () => void;
  onReconnect: () => void;
}

function TabContent({ tab, ip, suggestions, onCommand, onRetry, onRetrySkipPing, onReconnect }: TabContentProps) {
  const { status } = tab;

  // Connected — just render the terminal
  if (status === "connected") {
    return <SSHTerminal sessionId={tab.id} isConnected suggestions={suggestions} onCommand={onCommand} />;
  }

  // Connection lost — show terminal output (preserved) + reconnect overlay
  if (status === "lost") {
    return (
      <div className="relative h-full">
        {/* Terminal output stays visible underneath */}
        <div className="absolute inset-0 opacity-40 pointer-events-none">
          <SSHTerminal sessionId={tab.id} isConnected={false} suggestions={suggestions} onCommand={onCommand} />
        </div>
        {/* Overlay */}
        <div className="absolute inset-0 flex items-center justify-center"
          style={{ background: "rgba(8,8,15,0.75)", backdropFilter: "blur(2px)" }}>
          <div className="rounded-2xl border border-[#ef444430] p-8 flex flex-col items-center gap-4 max-w-sm w-full mx-4"
            style={{ background: "#0f0f1a" }}>
            {/* Pulse icon */}
            <div className="relative">
              <div className="w-12 h-12 rounded-full flex items-center justify-center"
                style={{ background: "#ef444415", border: "1px solid #ef444430" }}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M1 10h3l2-7 3 14 2-7 2 4 1-4h5" stroke="#ef4444" strokeWidth="1.5"
                    strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </div>
            <div className="text-center">
              <p className="text-white font-semibold mb-1">Connection lost</p>
              <p className="text-[#6b3333] text-[13px]">{ip} stopped responding</p>
            </div>
            <div className="flex gap-2 w-full">
              <button onClick={onReconnect}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all"
                style={{ background: "#00c8a8", color: "#000", boxShadow: "0 0 12px #00c8a830" }}>
                Reconnect
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Checking / connecting — spinner
  if (status === "checking" || status === "connecting") {
    const label = status === "checking" ? `Pinging ${ip}…` : "Connecting via SSH…";
    const subLabel = status === "checking"
      ? "Verifying host is reachable before SSH"
      : "Authenticating and opening shell";
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="relative">
          <div className="w-12 h-12 rounded-full border-2 border-[#1e1e35] flex items-center justify-center">
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#6366f1] animate-spin" />
            {status === "checking" ? (
              /* Ping icon */
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="2.5" fill="#6366f1" />
                <circle cx="8" cy="8" r="5" stroke="#6366f1" strokeWidth="1" strokeOpacity="0.4" />
                <circle cx="8" cy="8" r="7.5" stroke="#6366f1" strokeWidth="1" strokeOpacity="0.15" />
              </svg>
            ) : (
              /* SSH icon */
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="3" width="12" height="8" rx="1.5" stroke="#6366f1" strokeWidth="1" />
                <path d="M3.5 7.5L5 6L3.5 4.5" stroke="#6366f1" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6 7.5H8.5" stroke="#6366f1" strokeWidth="1" strokeLinecap="round" />
              </svg>
            )}
          </div>
        </div>
        <div className="text-center">
          <p className="text-white font-medium text-sm mb-1">{label}</p>
          <p className="text-[#374151] text-[12px]">{subLabel}</p>
        </div>
      </div>
    );
  }

  // Preflight failed — host unreachable
  if (status === "preflight_fail") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-8">
        <div className="w-12 h-12 rounded-full flex items-center justify-center"
          style={{ background: "#ef444410", border: "1px solid #ef444425" }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="8.5" stroke="#ef4444" strokeWidth="1.2" />
            <path d="M10 5v6M10 13v1.5" stroke="#ef4444" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </div>
        <div className="text-center max-w-xs">
          <p className="text-white font-semibold mb-1">Host unreachable</p>
          <p className="text-[#6b3333] text-[13px] mb-1">{tab.error}</p>
          <p className="text-[#374151] text-[12px]">
            ICMP ping failed. The host may be offline, or a firewall is blocking ping.
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full max-w-xs">
          <button onClick={onRetry}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{ background: "#6366f1", color: "#fff" }}>
            Try again
          </button>
          <button onClick={onRetrySkipPing}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-[#4b5563] hover:text-white hover:bg-[#1e1e35] transition-all border border-[#1e1e35]">
            Try SSH anyway
          </button>
        </div>
      </div>
    );
  }

  // SSH failed — auth error, port closed, etc.
  if (status === "ssh_fail") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-8">
        <div className="w-12 h-12 rounded-full flex items-center justify-center"
          style={{ background: "#ef444410", border: "1px solid #ef444425" }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <rect x="2" y="5" width="16" height="10" rx="2" stroke="#ef4444" strokeWidth="1.2" />
            <path d="M6 11l2-2.5L6 6" stroke="#ef4444" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 11h4" stroke="#ef4444" strokeWidth="1.1" strokeLinecap="round" />
            <path d="M4 3l12 14" stroke="#ef4444" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
        <div className="text-center max-w-xs">
          <p className="text-white font-semibold mb-1">SSH failed</p>
          <p className="text-[#6b3333] text-[13px] font-mono break-words">{tab.error}</p>
        </div>
        <button onClick={onRetry}
          className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all"
          style={{ background: "#6366f1", color: "#fff" }}>
          Retry
        </button>
      </div>
    );
  }

  // Disconnected (never tried)
  return (
    <div className="flex items-center justify-center h-full text-[#2d3748] text-sm">
      Not connected
    </div>
  );
}

// ── TabBar ────────────────────────────────────────────────────────────────────

interface TabBarProps {
  tabs: TerminalTab[];
  activeTabId: string | null;
  editingId: string | null;
  editingName: string;
  renameInputRef: React.RefObject<HTMLInputElement>;
  onActivate: (id: string) => void;
  onClose: (id: string, e: React.MouseEvent) => void;
  onAdd: () => void;
  onStartRename: (tab: TerminalTab) => void;
  onEditChange: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}

function TabBar({
  tabs, activeTabId, editingId, editingName, renameInputRef,
  onActivate, onClose, onAdd, onStartRename, onEditChange, onCommitRename, onCancelRename,
}: TabBarProps) {
  return (
    <div className="flex items-center border-t border-[#1e1e35] flex-shrink-0 overflow-x-auto"
      style={{ background: "#0a0a14", minHeight: 36 }}>

      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const sc = statusColor(tab.status);
        const isEditing = editingId === tab.id;

        return (
          <div key={tab.id}
            onClick={() => onActivate(tab.id)}
            className={`group flex items-center gap-2 px-3 h-9 border-r border-[#1e1e35] cursor-pointer flex-shrink-0 select-none transition-colors ${
              isActive ? "bg-[#0f0f1a]" : "hover:bg-[#0d0d1a]"
            }`}
            style={{ borderTop: isActive ? `2px solid ${sc}` : "2px solid transparent" }}
          >
            {/* Status dot */}
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isTransient(tab.status) ? "ping-pulsing" : ""}`}
              style={{ background: sc }} />

            {/* Editable name */}
            {isEditing ? (
              <input
                ref={renameInputRef}
                className="w-24 bg-transparent text-white text-[12px] font-medium outline-none border-b border-[#6366f1]"
                value={editingName}
                onChange={(e) => onEditChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommitRename();
                  if (e.key === "Escape") onCancelRename();
                }}
                onBlur={onCommitRename}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className={`text-[12px] font-medium max-w-[120px] truncate ${
                  isActive ? "text-white" : "text-[#4b5563] group-hover:text-[#6b7280]"
                }`}
                onDoubleClick={(e) => { e.stopPropagation(); onStartRename(tab); }}
                title="Double-click to rename"
              >
                {tab.name}
              </span>
            )}

            {/* Close */}
            <button
              onClick={(e) => onClose(tab.id, e)}
              className={`flex-shrink-0 w-4 h-4 flex items-center justify-center rounded text-[10px] transition-all ${
                isActive
                  ? "text-[#4b5563] hover:text-white hover:bg-[#1e1e35] opacity-100"
                  : "text-[#2d3748] hover:text-[#4b5563] opacity-0 group-hover:opacity-100"
              }`}
            >✕</button>
          </div>
        );
      })}

      <button onClick={onAdd}
        className="h-9 px-3 flex items-center text-[#374151] hover:text-[#6366f1] hover:bg-[#0d0d1a] transition-all flex-shrink-0"
        title="New terminal">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      <div className="flex-1" />
      <span className="text-[10px] text-[#1e2d3d] pr-3 flex-shrink-0 hidden lg:block select-none">
        double-click to rename
      </span>
    </div>
  );
}

// ── EmptyTerminalState ────────────────────────────────────────────────────────

function EmptyTerminalState({ hostname, onOpen }: { hostname: string; onOpen: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <div className="w-14 h-14 flex items-center justify-center rounded-2xl"
        style={{ background: "#6366f110", border: "1px solid #6366f120" }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="2" y="5" width="20" height="14" rx="2.5" stroke="#6366f1" strokeWidth="1.5" />
          <path d="M6 13l2.5-2.5L6 8" stroke="#6366f1" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M11 13h5" stroke="#6366f1" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-white font-semibold mb-1">No terminals open</p>
        <p className="text-[#4b5563] text-sm">Start an SSH session to {hostname}</p>
      </div>
      <button onClick={onOpen}
        className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all"
        style={{ background: "#6366f1", color: "#fff", boxShadow: "0 0 16px #6366f140" }}>
        + New Terminal
      </button>
    </div>
  );
}
