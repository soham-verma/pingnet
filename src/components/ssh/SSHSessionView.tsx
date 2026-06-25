import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SshConfig, SshConnectionStatus, TransferItem, PingResult, CommandEntry, AuditEntry } from "../../types";
import SSHConnectModal from "./SSHConnectModal";
import SSHTerminal from "./SSHTerminal";
import SFTPBrowser from "./SFTPBrowser";
import TransferQueue from "./TransferQueue";
import CommandHistory from "./CommandHistory";
import MetricsPanel from "./MetricsPanel";
import ApiClient from "./ApiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TerminalTab {
  id: string;
  name: string;
  status: SshConnectionStatus;
  error: string | null;
  color?: string;   // hex accent colour for tab top-border + dot
  icon?: string;    // emoji shown in tab label
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

type ViewTab = "terminal" | "files" | "history" | "metrics" | "grafana" | "api";

// Per-host Grafana configuration (stored in component state, persisted to localStorage)
export interface GrafanaConfig {
  url: string;       // e.g. http://192.168.1.100:3000
  kiosk: boolean;    // append ?kiosk to hide sidebar
  autoRefresh: string; // e.g. "5m" — appended as &refresh=5m
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(): string {
  // crypto.randomUUID() provides full RFC 4122 UUID entropy — much safer than
  // Math.random() (~30 bits) for IDs used as Tauri event listener names.
  return crypto.randomUUID();
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
    default:               return "var(--text4)";
  }
}

function isTransient(s: SshConnectionStatus): boolean {
  return s === "checking" || s === "connecting";
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SSHSessionView({
  hostname,
  ip,
  hostId,
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
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [auditNewCount, setAuditNewCount] = useState(0);
  const [filesSubTab, setFilesSubTab] = useState<"browse" | "transfers">("browse");
  const [historySubTab, setHistorySubTab] = useState<"commands" | "audit">("commands");

  // ── Split + broadcast state ───────────────────────────────────────────────
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  const [splitRatio, setSplitRatio] = useState(50); // % width for left pane
  const [broadcastMode, setBroadcastMode] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // ── Grafana config — persisted per host in localStorage ────────────────────
  const grafanaStorageKey = `pingnet_grafana_${hostId}`;

  function readGrafanaConfig(key: string): GrafanaConfig {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw) as GrafanaConfig;
    } catch {}
    return { url: "", kiosk: true, autoRefresh: "5m" };
  }

  const [grafanaConfig, setGrafanaConfig] = useState<GrafanaConfig>(() =>
    readGrafanaConfig(grafanaStorageKey)
  );
  const [showGrafanaSettings, setShowGrafanaSettings] = useState(false);

  // Re-read Grafana config from localStorage whenever the host changes —
  // the useState initializer only runs on first mount, so without this,
  // switching hosts leaves the previous host's config in state.
  useEffect(() => {
    setGrafanaConfig(readGrafanaConfig(grafanaStorageKey));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  const saveGrafanaConfig = useCallback((cfg: GrafanaConfig) => {
    setGrafanaConfig(cfg);
    localStorage.setItem(grafanaStorageKey, JSON.stringify(cfg));
  }, [grafanaStorageKey]);

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

    // Append to per-host audit log (JSONL file via Rust)
    const ts = Date.now();
    const entry: AuditEntry = {
      ts,
      host: ip,
      username: storedCreds?.config.username ?? "",
      command: cmd.trim(),
    };
    invoke("append_audit_log", {
      hostId,
      host: entry.host,
      username: entry.username,
      command: entry.command,
      ts,
    }).catch(() => {});
    setAuditLog(prev => [entry, ...prev]);
    setAuditNewCount(prev => prev + 1);

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

  // Load persisted history + audit log when the first connection goes live
  const historyLoadedRef = useRef(false);
  useEffect(() => {
    const anyConnected = tabs.some(t => t.status === "connected");
    if (anyConnected && !historyLoadedRef.current) {
      historyLoadedRef.current = true;
      invoke<CommandEntry[]>("load_command_history", { host: ip })
        .then(setCommands)
        .catch(() => {});
      invoke<AuditEntry[]>("load_audit_log", { hostId })
        .then(entries => setAuditLog([...entries].reverse())) // newest first
        .catch(() => {});
    }
  }, [tabs, ip, hostId]);

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
          : creds.config.auth_type === "keychain"
          ? { type: "KeychainKey", key_name: creds.config.key_name ?? "" }
          : creds.config.auth_type === "agent"
          ? { type: "Agent" }
          : creds.config.auth_type === "totp"
          ? { type: "KbdInt", totp_code: creds.password }
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

    if (tabId === splitTabId) setSplitTabId(null);

    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
  };

  // ── Split terminal ────────────────────────────────────────────────────────

  const handleSplit = useCallback(() => {
    const id = uid();
    setTabs((prev) => [...prev, { id, name: defaultName(prev), status: "disconnected", error: null }]);
    setSplitTabId(id);
    setSplitRatio(50);
    setViewTab("terminal");

    if (storedCreds) {
      connectTab(id, storedCreds);
    } else {
      pendingTabId.current = id;
      setShowModal(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedCreds]);

  /** Merge: close the split VIEW — the right-pane tab stays in the left tab bar. */
  const handleMerge = useCallback(() => {
    setSplitTabId(null);
  }, []);

  /** Remove split: close the split VIEW and disconnect + destroy the right-pane terminal. */
  const handleRemoveSplit = useCallback(async () => {
    if (!splitTabId) return;
    const tabId = splitTabId;
    setSplitTabId(null);
    unlistenMap.current.get(tabId)?.();
    unlistenMap.current.delete(tabId);
    try { await invoke("ssh_disconnect", { sessionId: tabId }); } catch {}
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId) setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitTabId, activeTabId]);

  const handleDividerDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    const startX = e.clientX;
    const startRatio = splitRatio;
    const containerWidth = container.getBoundingClientRect().width;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setSplitRatio(Math.min(80, Math.max(20, startRatio + (delta / containerWidth) * 100)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [splitRatio]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const connectedTabs = tabs.filter((t) => t.status === "connected");
  const primarySessionId = connectedTabs[0]?.id ?? null;
  const anyConnected = connectedTabs.length > 0;
  const activeTransfers = transfers.filter((t) => t.status === "running").length;

  // For each tab, the set of other connected session IDs to broadcast to
  const broadcastTargetsFor = useMemo(() => {
    if (!broadcastMode) return (_id: string) => ([] as string[]);
    const connectedIds = connectedTabs.map(t => t.id);
    return (id: string) => connectedIds.filter(cid => cid !== id);
  }, [broadcastMode, connectedTabs]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border)] flex-shrink-0"
        style={{ background: "var(--bg1)" }}>

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
            <span className="text-[var(--text)] font-semibold text-sm">{hostname}</span>
            {anyConnected && (
              <span className="text-[11px] px-2 py-0.5 rounded-full"
                style={{ background: "#22c55e15", color: "#22c55e", border: "1px solid #22c55e25" }}>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#22c55e] mr-1 align-middle" />
                {connectedTabs.length} connected
              </span>
            )}
          </div>
          <div className="text-[11px] text-[var(--text4)] font-mono mt-0.5">
            {storedCreds ? `${storedCreds.config.username}@${ip}:${storedCreds.config.port}` : ip}
          </div>
        </div>

        {/* View tabs */}
        <div className="flex items-center gap-1 bg-[var(--bg2)] rounded-lg p-1 border border-[var(--border)]">
          {(["terminal", "files", "history", "metrics", "grafana", "api"] as ViewTab[]).map((t) => (
            <button key={t}
              onClick={() => setViewTab(t)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all capitalize ${
                viewTab === t ? "bg-[var(--border)] text-[var(--text)]" : "text-[var(--text3)] hover:text-[var(--text2)]"
              }`}
            >
              {t}
              {/* files: badge for active transfers */}
              {t === "files" && activeTransfers > 0 && (
                <span className="w-3.5 h-3.5 flex items-center justify-center rounded-full text-[8px] font-bold bg-[#6366f1] text-[var(--text)]">
                  {activeTransfers}
                </span>
              )}
              {/* history: new command-tool flash dot */}
              {t === "history" && newToolFlash && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#00c8a8] animate-pulse" title={`New tool: ${newToolFlash}`} />
              )}
              {/* history: audit badge */}
              {t === "history" && !newToolFlash && auditNewCount > 0 && (
                <span className="w-3.5 h-3.5 flex items-center justify-center rounded-full text-[8px] font-bold bg-[#ef4444] text-[var(--text)]">
                  {auditNewCount > 99 ? "99+" : auditNewCount}
                </span>
              )}
              {/* history: command count */}
              {t === "history" && !newToolFlash && auditNewCount === 0 && commands.length > 0 && (
                <span className="text-[9px] text-[var(--text4)]">{commands.length}</span>
              )}
              {t === "grafana" && grafanaConfig.url && (
                <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b]" />
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
              {/* Broadcast banner */}
              {broadcastMode && connectedTabs.length > 1 && (
                <div className="flex items-center gap-2 px-4 py-1.5 flex-shrink-0 text-[11px] font-medium"
                  style={{ background: "#2e1f05", borderBottom: "1px solid #f59e0b30", color: "#f59e0b" }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12s1.5-4 7-4 7 4 7 4M5 12s1.5 4 7 4 7-4 7-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                    <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                  </svg>
                  Broadcasting to {connectedTabs.length} terminals — all input is mirrored
                </div>
              )}

              {/* Pane area — supports horizontal split */}
              <div className="flex flex-1 min-h-0 overflow-hidden" ref={splitContainerRef}>

                {/* Primary pane — mounts every tab EXCEPT the split tab so
                    each SSHTerminal instance (and its xterm + listeners) exists
                    in exactly one pane at a time. */}
                <div className="relative h-full" style={{ width: splitTabId ? `${splitRatio}%` : "100%" }}>
                  {tabs.filter(t => t.id !== splitTabId).map((tab) => (
                    <div key={tab.id} className="absolute inset-0"
                      style={{ display: tab.id === activeTabId ? "block" : "none", background: "var(--bg)" }}>
                      <TabContent
                        tab={tab}
                        ip={ip}
                        port={storedCreds?.config.port ?? 22}
                        suggestions={suggestions}
                        onCommand={handleCommand}
                        onRetry={() => storedCreds && connectTab(tab.id, storedCreds)}
                        onRetrySkipPing={() => storedCreds && connectTab(tab.id, storedCreds, true)}
                        onReconnect={() => reconnectTab(tab.id)}
                        onTrustNewKey={async (host, port, fingerprint) => {
                          await invoke("trust_host_key", { host, port, fingerprint });
                        }}
                        broadcastTo={broadcastTargetsFor(tab.id)}
                      />
                    </div>
                  ))}
                </div>

                {/* Drag divider + secondary pane — only when split is active */}
                {splitTabId && (() => {
                  const splitTab = tabs.find(t => t.id === splitTabId);
                  if (!splitTab) return null;
                  const sc = splitTab.color ?? statusColor(splitTab.status);
                  return (
                    <>
                      {/* Drag divider */}
                      <div
                        className="flex-shrink-0 cursor-col-resize transition-colors"
                        style={{ width: 3, background: "var(--border2)" }}
                        onMouseDown={handleDividerDrag}
                        onMouseEnter={e => (e.currentTarget.style.background = "#6366f1")}
                        onMouseLeave={e => (e.currentTarget.style.background = "var(--border2)")}
                      />

                      {/* Secondary pane — mounts ONLY the split tab */}
                      <div className="flex flex-col h-full" style={{ flex: 1, minWidth: 0 }}>

                        {/* Right pane header */}
                        <div
                          className="flex items-center gap-2 px-3 flex-shrink-0 border-b select-none"
                          style={{ height: 30, background: "var(--bg1)", borderColor: "var(--border)", borderTop: `2px solid ${sc}` }}
                        >
                          {splitTab.icon ? (
                            <span className="text-[12px] leading-none">{splitTab.icon}</span>
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                              style={{ background: sc }} />
                          )}
                          <span className="text-[11px] font-medium truncate max-w-[120px]"
                            style={{ color: "var(--text2)" }}>
                            {splitTab.name}
                          </span>

                          <div className="flex-1" />

                          {/* Merge: close split VIEW, tab stays in left panel tab bar */}
                          <button
                            onClick={handleMerge}
                            title="Merge — move terminal back to main panel (keeps session)"
                            className="h-6 px-2 flex items-center gap-1 rounded text-[10px] font-medium transition-colors"
                            style={{ color: "var(--text3)" }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg3)"; (e.currentTarget as HTMLElement).style.color = "var(--text)"; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ""; (e.currentTarget as HTMLElement).style.color = "var(--text3)"; }}
                          >
                            {/* merge-left icon */}
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                              <rect x="1" y="2" width="6" height="12" rx="1" stroke="currentColor" strokeWidth="1.4"/>
                              <rect x="9" y="2" width="6" height="12" rx="1" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.2"/>
                              <path d="M12 8H7M9 6l-2 2 2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                            Merge
                          </button>

                          {/* Close: disconnect + remove the terminal entirely */}
                          <button
                            onClick={handleRemoveSplit}
                            title="Close terminal — disconnect and remove"
                            className="h-6 w-6 flex items-center justify-center rounded text-[11px] transition-colors ml-0.5"
                            style={{ color: "var(--text3)" }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#2e0d0d"; (e.currentTarget as HTMLElement).style.color = "#f87171"; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ""; (e.currentTarget as HTMLElement).style.color = "var(--text3)"; }}
                          >✕</button>
                        </div>

                        {/* Terminal content */}
                        <div className="flex-1 min-h-0 relative">
                          <div className="absolute inset-0">
                            <TabContent
                              tab={splitTab}
                              ip={ip}
                              port={storedCreds?.config.port ?? 22}
                              suggestions={suggestions}
                              onCommand={handleCommand}
                              onRetry={() => storedCreds && connectTab(splitTab.id, storedCreds)}
                              onRetrySkipPing={() => storedCreds && connectTab(splitTab.id, storedCreds, true)}
                              onReconnect={() => reconnectTab(splitTab.id)}
                              onTrustNewKey={async (host, port, fingerprint) => {
                                await invoke("trust_host_key", { host, port, fingerprint });
                              }}
                              broadcastTo={broadcastTargetsFor(splitTab.id)}
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Tab bar */}
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                splitTabId={splitTabId}
                broadcastMode={broadcastMode}
                editingId={editingId}
                editingName={editingName}
                renameInputRef={renameInputRef}
                onActivate={(id) => {
                  if (id === splitTabId) {
                    // Clicking the split tab in the bottom bar → merge it to the left pane
                    setSplitTabId(null);
                    setActiveTabId(id);
                  } else {
                    setActiveTabId(id);
                  }
                }}
                onClose={closeTab}
                onAdd={addTab}
                onSplit={handleSplit}
                onToggleBroadcast={() => setBroadcastMode(v => !v)}
                onSplitActivate={setSplitTabId}
                onStartRename={startRename}
                onEditChange={setEditingName}
                onCommitRename={commitRename}
                onCancelRename={() => setEditingId(null)}
                onSetTabColor={(tabId, color) =>
                  setTabs(prev => prev.map(t => t.id === tabId ? { ...t, color } : t))
                }
                onSetTabIcon={(tabId, icon) =>
                  setTabs(prev => prev.map(t => t.id === tabId ? { ...t, icon } : t))
                }
              />
            </>
          )}
        </div>

        {/* Files panel — SFTP browser + transfers sub-tabs */}
        {viewTab === "files" && (
          <div className="absolute inset-0 flex flex-col">
            {/* Sub-tab strip */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border)]" style={{ background: "var(--bg1)" }}>
              {(["browse", "transfers"] as const).map((s) => (
                <button key={s}
                  onClick={() => setFilesSubTab(s)}
                  className="px-3 py-1 rounded text-[11px] font-medium capitalize transition-all flex items-center gap-1.5"
                  style={filesSubTab === s
                    ? { background: "var(--border)", color: "var(--text)" }
                    : { color: "var(--text3)" }}
                >
                  {s === "browse" ? "Browse" : "Transfers"}
                  {s === "transfers" && activeTransfers > 0 && (
                    <span className="w-3.5 h-3.5 flex items-center justify-center rounded-full text-[8px] font-bold bg-[#6366f1] text-[var(--text)]">
                      {activeTransfers}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Browse sub-panel */}
            <div className="flex-1 overflow-hidden relative">
              {filesSubTab === "browse" && (
                primarySessionId ? (
                  <div className="absolute inset-0">
                    <SFTPBrowser
                      sessionId={primarySessionId}
                      host={ip}
                      username={storedCreds?.config.username ?? ""}
                      port={storedCreds?.config.port ?? 22}
                      onUploadStart={(id, name, totalBytes) =>
                        setTransfers((p) => [...p, { id, name, kind: "upload", bytes_done: 0, total_bytes: totalBytes, status: "running" }])
                      }
                      onDownloadStart={(id, name) =>
                        setTransfers((p) => [...p, { id, name, kind: "download", bytes_done: 0, total_bytes: 0, status: "running" }])
                      }
                    />
                  </div>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--text4)]">
                    <p className="text-sm">No active connection</p>
                    <p className="text-[12px] text-[var(--text5)]">Open a terminal and connect first</p>
                  </div>
                )
              )}

              {/* Transfers sub-panel */}
              {filesSubTab === "transfers" && (
                <div className="absolute inset-0">
                  <TransferQueue
                    transfers={transfers}
                    onClear={() => setTransfers((p) => p.filter((t) => t.status === "running"))}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* History panel — command history + audit sub-tabs */}
        {viewTab === "history" && (
          <div className="absolute inset-0 flex flex-col">
            {/* Sub-tab strip */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border)]" style={{ background: "var(--bg1)" }}>
              {(["commands", "audit"] as const).map((s) => (
                <button key={s}
                  onClick={() => {
                    setHistorySubTab(s);
                    if (s === "audit") setAuditNewCount(0);
                  }}
                  className="px-3 py-1 rounded text-[11px] font-medium capitalize transition-all flex items-center gap-1.5"
                  style={historySubTab === s
                    ? { background: "var(--border)", color: "var(--text)" }
                    : { color: "var(--text3)" }}
                >
                  {s === "commands" ? "Commands" : "Audit log"}
                  {s === "commands" && commands.length > 0 && (
                    <span className="text-[9px] text-[var(--text4)]">{commands.length}</span>
                  )}
                  {s === "audit" && auditNewCount > 0 && (
                    <span className="w-3.5 h-3.5 flex items-center justify-center rounded-full text-[8px] font-bold bg-[#ef4444] text-[var(--text)]">
                      {auditNewCount > 99 ? "99+" : auditNewCount}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-hidden relative">
              {historySubTab === "commands" && (
                <div className="absolute inset-0">
                  <CommandHistory
                    commands={commands}
                    activeSessionId={primarySessionId}
                    onRun={() => setViewTab("terminal")}
                  />
                </div>
              )}
              {historySubTab === "audit" && (
                <AuditPanel
                  entries={auditLog}
                  hostId={hostId}
                  onClear={() => {
                    invoke("clear_audit_log", { hostId }).catch(() => {});
                    setAuditLog([]);
                    setAuditNewCount(0);
                  }}
                />
              )}
            </div>
          </div>
        )}

        {/* Metrics panel — only when connected */}
        {primarySessionId ? (
          <div className="absolute inset-0 flex flex-col"
            style={{ display: viewTab === "metrics" ? "flex" : "none" }}>
            <MetricsPanel
              sessionId={primarySessionId}
              isActive={viewTab === "metrics"}
            />
          </div>
        ) : viewTab === "metrics" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--text4)]">
            <p className="text-sm">No active connection</p>
            <p className="text-[12px] text-[var(--text5)]">Open a terminal and connect first</p>
          </div>
        ) : null}

        {/* Grafana embed panel — always mounted when grafana tab active */}
        {viewTab === "grafana" && (
          <div className="absolute inset-0 flex flex-col" style={{ background: "var(--bg)" }}>
            <GrafanaPanel
              config={grafanaConfig}
              showSettings={showGrafanaSettings}
              onToggleSettings={() => setShowGrafanaSettings((v) => !v)}
              onSave={saveGrafanaConfig}
            />
          </div>
        )}

        {/* API client panel */}
        {viewTab === "api" && (
          <div className="absolute inset-0 flex flex-col overflow-hidden">
            <ApiClient
              hostId={hostId}
              sessionId={activeTabId}
            />
          </div>
        )}
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

// Parse the structured HOST_KEY_CHANGED error emitted by ssh.rs
// Format: "HOST_KEY_CHANGED\x00host=...\x00stored=...\x00current=..."
function parseHostKeyChanged(error: string | null): { host: string; stored: string; current: string } | null {
  if (!error?.startsWith("HOST_KEY_CHANGED")) return null;
  const parts = Object.fromEntries(
    error.split("\x00").slice(1).map((p) => p.split("=") as [string, string])
  );
  if (!parts.host || !parts.stored || !parts.current) return null;
  return { host: parts.host, stored: parts.stored, current: parts.current };
}

interface TabContentProps {
  tab: TerminalTab;
  ip: string;
  port: number;
  suggestions: string[];
  onCommand: (cmd: string) => void;
  onRetry: () => void;
  onRetrySkipPing: () => void;
  onReconnect: () => void;
  onTrustNewKey: (host: string, port: number, fingerprint: string) => Promise<void>;
  broadcastTo?: string[];
}

function TabContent({ tab, ip, port, suggestions, onCommand, onRetry, onRetrySkipPing, onReconnect, onTrustNewKey, broadcastTo }: TabContentProps) {
  const { status } = tab;

  // Connected — just render the terminal
  if (status === "connected") {
    return <SSHTerminal sessionId={tab.id} isConnected suggestions={suggestions} onCommand={onCommand} broadcastTo={broadcastTo} />;
  }

  // Connection lost — show terminal output (preserved) + reconnect overlay
  if (status === "lost") {
    return (
      <div className="relative h-full">
        {/* Terminal output stays visible underneath */}
        <div className="absolute inset-0 opacity-40 pointer-events-none">
          <SSHTerminal sessionId={tab.id} isConnected={false} suggestions={suggestions} onCommand={onCommand} broadcastTo={[]} />
        </div>
        {/* Overlay */}
        <div className="absolute inset-0 flex items-center justify-center"
          style={{ background: "rgba(8,8,15,0.75)", backdropFilter: "blur(2px)" }}>
          <div className="rounded-2xl border border-[#ef444430] p-8 flex flex-col items-center gap-4 max-w-sm w-full mx-4"
            style={{ background: "var(--bg2)" }}>
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
              <p className="text-[var(--text)] font-semibold mb-1">Connection lost</p>
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
          <div className="w-12 h-12 rounded-full border-2 border-[var(--border)] flex items-center justify-center">
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
          <p className="text-[var(--text)] font-medium text-sm mb-1">{label}</p>
          <p className="text-[var(--text4)] text-[12px]">{subLabel}</p>
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
          <p className="text-[var(--text)] font-semibold mb-1">Host unreachable</p>
          <p className="text-[#6b3333] text-[13px] mb-1">{tab.error}</p>
          <p className="text-[var(--text4)] text-[12px]">
            ICMP ping failed. The host may be offline, or a firewall is blocking ping.
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full max-w-xs">
          <button onClick={onRetry}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all"
            style={{ background: "#6366f1", color: "var(--text)" }}>
            Try again
          </button>
          <button onClick={onRetrySkipPing}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all border border-[var(--border)]">
            Try SSH anyway
          </button>
        </div>
      </div>
    );
  }

  // SSH failed — check if it's a host key mismatch first
  if (status === "ssh_fail") {
    const hkc = parseHostKeyChanged(tab.error);

    if (hkc) {
      // ── Host key changed warning ──────────────────────────────────────────
      return (
        <div className="flex flex-col items-center justify-center h-full gap-5 px-8">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: "#f59e0b10", border: "1px solid #f59e0b35" }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L2 20h20L12 2z" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M12 9v5M12 16.5v1" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </div>

          <div className="text-center max-w-sm">
            <p className="text-[var(--text)] font-semibold text-base mb-1">Host key has changed</p>
            <p className="text-[var(--text2)] text-[13px] mb-4">
              The SSH fingerprint for <span className="text-[var(--text)] font-mono">{hkc.host}</span> no longer matches what was stored. This could mean the server was reinstalled — or it could be a man-in-the-middle attack.
            </p>

            <div className="rounded-xl overflow-hidden text-left mb-4"
              style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
              <div className="px-4 py-2.5 border-b border-[var(--border)]">
                <p className="text-[10px] tracking-[0.15em] uppercase text-[var(--text3)]">Fingerprint comparison</p>
              </div>
              <div className="px-4 py-3 space-y-2">
                <div>
                  <p className="text-[9px] uppercase tracking-wider text-[var(--text3)] mb-0.5">Stored (trusted)</p>
                  <p className="font-mono text-[12px] text-[#22c55e] break-all">{hkc.stored}</p>
                </div>
                <div className="border-t border-[var(--border)] pt-2">
                  <p className="text-[9px] uppercase tracking-wider text-[var(--text3)] mb-0.5">Current (server)</p>
                  <p className="font-mono text-[12px] text-[#f59e0b] break-all">{hkc.current}</p>
                </div>
              </div>
            </div>

            <p className="text-[11px] text-[var(--text3)]">
              Only click "Trust New Key" if you are certain the server was legitimately reinstalled or the key was rotated.
            </p>
          </div>

          <div className="flex flex-col gap-2 w-full max-w-xs">
            <button
              onClick={async () => {
                await onTrustNewKey(hkc.host, port, hkc.current);
                // Host was already reachable (we just got a key-changed error from it)
                // — skip the redundant preflight ping and go straight to SSH.
                onRetrySkipPing();
              }}
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{ background: "#f59e0b", color: "#000", boxShadow: "0 0 16px #f59e0b30" }}>
              Trust New Key &amp; Reconnect
            </button>
            <button onClick={onRetry}
              className="w-full py-2.5 rounded-xl text-sm font-medium transition-all text-[var(--text3)] hover:text-[var(--text)]"
              style={{ border: "1px solid var(--border)" }}>
              Abort — Keep Stored Key
            </button>
          </div>
        </div>
      );
    }

    // ── Generic SSH failure ───────────────────────────────────────────────────
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
          <p className="text-[var(--text)] font-semibold mb-1">SSH failed</p>
          <p className="text-[#6b3333] text-[13px] font-mono break-words">{tab.error}</p>
        </div>
        <button onClick={onRetry}
          className="px-6 py-2.5 rounded-xl text-sm font-semibold transition-all"
          style={{ background: "#6366f1", color: "var(--text)" }}>
          Retry
        </button>
      </div>
    );
  }

  // Disconnected (never tried)
  return (
    <div className="flex items-center justify-center h-full text-[var(--text5)] text-sm">
      Not connected
    </div>
  );
}

// ── TabBar ────────────────────────────────────────────────────────────────────

const TAB_COLORS = [
  "#22c55e", "#6366f1", "#f59e0b", "#ef4444",
  "#00c8a8", "#a78bfa", "#60a5fa", "#f87171",
];
const TAB_ICONS = ["⚡", "🔧", "📦", "🌐", "🔍", "🚀", "🐛", "📊"];

interface TabBarProps {
  tabs: TerminalTab[];
  activeTabId: string | null;
  splitTabId: string | null;
  broadcastMode: boolean;
  editingId: string | null;
  editingName: string;
  renameInputRef: React.RefObject<HTMLInputElement>;
  onActivate: (id: string) => void;
  onSplitActivate: (id: string) => void;
  onClose: (id: string, e: React.MouseEvent) => void;
  onAdd: () => void;
  onSplit: () => void;
  onToggleBroadcast: () => void;
  onStartRename: (tab: TerminalTab) => void;
  onEditChange: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSetTabColor: (tabId: string, color: string | undefined) => void;
  onSetTabIcon: (tabId: string, icon: string | undefined) => void;
}

function TabBar({
  tabs, activeTabId, splitTabId, broadcastMode,
  editingId, editingName, renameInputRef,
  onActivate, onSplitActivate, onClose, onAdd,
  onSplit, onToggleBroadcast,
  onStartRename, onEditChange, onCommitRename, onCancelRename,
  onSetTabColor, onSetTabIcon,
}: TabBarProps) {
  const [ctxMenu, setCtxMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [ctxMenu]);

  const ctxTab = ctxMenu ? tabs.find(t => t.id === ctxMenu.tabId) : null;

  return (
    <div className="flex items-center border-t border-[var(--border)] flex-shrink-0 overflow-x-auto relative"
      style={{ background: "var(--bg1)", minHeight: 36 }}>

      {/* ── Tab list ── */}
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isSplit = tab.id === splitTabId;
        const sc = tab.color ?? statusColor(tab.status);
        const isEditing = editingId === tab.id;

        return (
          <div key={tab.id}
            onClick={() => onActivate(tab.id)}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ tabId: tab.id, x: e.clientX, y: e.clientY }); }}
            className={`group flex items-center gap-1.5 px-3 h-9 border-r border-[var(--border)] cursor-pointer flex-shrink-0 select-none transition-colors ${
              isActive ? "bg-[var(--bg2)]" : "hover:bg-[var(--bg2)]"
            }`}
            style={{ borderTop: (isActive || isSplit) ? `2px solid ${sc}` : "2px solid transparent",
                     opacity: isSplit && !isActive ? 0.85 : 1 }}
          >
            {/* Icon (emoji) or status dot */}
            {tab.icon ? (
              <span className="text-[12px] leading-none flex-shrink-0">{tab.icon}</span>
            ) : (
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isTransient(tab.status) ? "ping-pulsing" : ""}`}
                style={{ background: sc }} />
            )}

            {/* Editable name */}
            {isEditing ? (
              <input
                ref={renameInputRef}
                className="w-24 bg-transparent text-[var(--text)] text-[12px] font-medium outline-none border-b border-[#6366f1]"
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
                  isActive ? "text-[var(--text)]" : "text-[var(--text3)] group-hover:text-[var(--text2)]"
                }`}
                onDoubleClick={(e) => { e.stopPropagation(); onStartRename(tab); }}
                title={tab.name}
              >
                {tab.name}
              </span>
            )}

            {/* "split" badge on the right-pane tab */}
            {isSplit && (
              <span className="text-[9px] px-1 rounded flex-shrink-0"
                style={{ background: "#6366f115", color: "#818cf8", border: "1px solid #6366f125" }}>
                split
              </span>
            )}

            {/* Close */}
            <button
              onClick={(e) => onClose(tab.id, e)}
              className={`flex-shrink-0 w-4 h-4 flex items-center justify-center rounded text-[10px] transition-all ${
                isActive
                  ? "text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] opacity-100"
                  : "text-[var(--text5)] hover:text-[var(--text3)] opacity-0 group-hover:opacity-100"
              }`}
            >✕</button>
          </div>
        );
      })}

      {/* ── New tab ── */}
      <button onClick={onAdd}
        className="h-9 px-3 flex items-center text-[var(--text4)] hover:text-[#6366f1] hover:bg-[var(--bg2)] transition-all flex-shrink-0"
        title="New terminal (new SSH session)">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      <div className="flex-1" />

      {/* ── Toolbar actions ── */}
      <div className="flex items-center gap-0.5 px-2 flex-shrink-0">

        {/* Broadcast toggle */}
        <button
          onClick={onToggleBroadcast}
          title={broadcastMode ? "Broadcast ON — click to turn off" : "Broadcast input to all terminals"}
          className="h-7 px-2 flex items-center gap-1 rounded text-[11px] font-medium transition-all"
          style={broadcastMode
            ? { background: "#2e1f05", color: "#f59e0b", border: "1px solid #f59e0b30" }
            : { color: "var(--text4)", background: "transparent" }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M5 12s1.5-4 7-4 7 4 7 4M5 12s1.5 4 7 4 7-4 7-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
          </svg>
          {broadcastMode && <span>Broadcast</span>}
        </button>

        {/* Split — always available; when split is active the right pane header owns Merge/Close */}
        <button
          onClick={onSplit}
          title={splitTabId ? "Open another split terminal" : "Split terminal — opens new session side-by-side"}
          className="h-7 px-2 flex items-center gap-1 rounded text-[11px] font-medium transition-colors"
          style={splitTabId
            ? { color: "#818cf8", background: "#6366f110", border: "1px solid #6366f120" }
            : { color: "var(--text3)" }}
          onMouseEnter={e => { if (!splitTabId) (e.currentTarget as HTMLElement).style.color = "var(--text)"; }}
          onMouseLeave={e => { if (!splitTabId) (e.currentTarget as HTMLElement).style.color = "var(--text3)"; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <rect x="2" y="3" width="9" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
            <rect x="13" y="3" width="9" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
            <path d="M11.5 12h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          Split
        </button>
      </div>

      {/* ── Context menu ── */}
      {ctxMenu && ctxTab && (
        <div
          className="fixed z-50 rounded-xl border py-2 shadow-2xl min-w-[200px]"
          style={{
            left: ctxMenu.x, top: ctxMenu.y - 8,
            background: "var(--bg2)", borderColor: "var(--border2)",
            transform: "translateY(-100%)",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Colour swatches */}
          <div className="px-3 pb-1.5">
            <p className="text-[9px] tracking-widest uppercase text-[var(--text3)] mb-2">Colour</p>
            <div className="flex gap-1.5 flex-wrap">
              {TAB_COLORS.map(c => (
                <button key={c}
                  onClick={() => { onSetTabColor(ctxTab.id, ctxTab.color === c ? undefined : c); setCtxMenu(null); }}
                  className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                  style={{ background: c, boxShadow: ctxTab.color === c ? `0 0 0 2px var(--bg2), 0 0 0 3px ${c}` : "none" }}
                />
              ))}
              {ctxTab.color && (
                <button
                  onClick={() => { onSetTabColor(ctxTab.id, undefined); setCtxMenu(null); }}
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] transition-colors"
                  style={{ border: "1px solid var(--border2)", color: "var(--text3)" }}
                  title="Clear colour"
                >✕</button>
              )}
            </div>
          </div>

          {/* Icon swatches */}
          <div className="px-3 pt-1 pb-1.5 border-t border-[var(--border)]">
            <p className="text-[9px] tracking-widest uppercase text-[var(--text3)] mb-2 mt-1.5">Icon</p>
            <div className="flex gap-1 flex-wrap">
              {TAB_ICONS.map(ic => (
                <button key={ic}
                  onClick={() => { onSetTabIcon(ctxTab.id, ctxTab.icon === ic ? undefined : ic); setCtxMenu(null); }}
                  className="w-7 h-7 rounded-md text-sm flex items-center justify-center transition-colors"
                  style={ctxTab.icon === ic
                    ? { background: "var(--bg4)", border: "1px solid var(--border2)" }
                    : { background: "transparent" }}
                >{ic}</button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="pt-1 border-t border-[var(--border)]">
            <button
              onClick={() => { onStartRename(ctxTab); setCtxMenu(null); }}
              className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--text2)] hover:bg-[var(--bg3)] hover:text-[var(--text)] transition-colors"
            >Rename</button>
            {ctxTab.id !== splitTabId && (
              <button
                onClick={() => { onSplitActivate(ctxTab.id); setCtxMenu(null); }}
                className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--text2)] hover:bg-[var(--bg3)] hover:text-[var(--text)] transition-colors"
              >{splitTabId ? "Replace split pane" : "Move to split pane"}</button>
            )}
            <button
              onClick={(e) => { onClose(ctxTab.id, e as unknown as React.MouseEvent); setCtxMenu(null); }}
              className="w-full text-left px-3 py-1.5 text-[12px] text-[#f87171] hover:bg-[#2e0d0d] transition-colors"
            >Close terminal</button>
          </div>
        </div>
      )}
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
        <p className="text-[var(--text)] font-semibold mb-1">No terminals open</p>
        <p className="text-[var(--text3)] text-sm">Start an SSH session to {hostname}</p>
      </div>
      <button onClick={onOpen}
        className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all"
        style={{ background: "#6366f1", color: "#fff", boxShadow: "0 0 16px #6366f140" }}>
        + New Terminal
      </button>
    </div>
  );
}

// ── GrafanaPanel ───────────────────────────────────────────────────────────────

function buildGrafanaUrl(cfg: GrafanaConfig): string {
  if (!cfg.url) return "";
  const base = cfg.url.replace(/\/$/, "");
  const params: string[] = [];
  if (cfg.kiosk) params.push("kiosk");
  if (cfg.autoRefresh) params.push(`refresh=${encodeURIComponent(cfg.autoRefresh)}`);
  const query = params.length > 0 ? "?" + params.join("&") : "";
  return `${base}${query}`;
}

function GrafanaPanel({
  config,
  showSettings,
  onToggleSettings,
  onSave,
}: {
  config: GrafanaConfig;
  showSettings: boolean;
  onToggleSettings: () => void;
  onSave: (cfg: GrafanaConfig) => void;
}) {
  const [draft, setDraft] = useState<GrafanaConfig>(config);
  const iframeUrl = buildGrafanaUrl(config);

  // Sync draft when config changes from outside (e.g. host switch)
  useEffect(() => { setDraft(config); }, [config]);

  const handleSave = () => {
    onSave(draft);
    onToggleSettings();
  };

  const inputCls = "w-full bg-[var(--bg1)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13px] text-[var(--text)] font-mono placeholder-[var(--text4)] outline-none focus:border-[#00c8a860]";
  const labelCls = "block text-[10px] tracking-[0.12em] text-[var(--text3)] uppercase mb-1.5";

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] flex-shrink-0"
        style={{ background: "var(--bg1)" }}>
        {/* Grafana "G" badge */}
        <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
          style={{ background: "#f59e0b20", border: "1px solid #f59e0b30" }}>
          <span className="text-[#f59e0b] text-[9px] font-bold">G</span>
        </div>
        <span className="text-[11px] text-[var(--text2)] font-medium flex-1 truncate">
          {config.url || "No dashboard configured"}
        </span>
        {config.url && (
          <button
            onClick={() => {
              // Reload the iframe by toggling key
              const el = document.getElementById("grafana-iframe") as HTMLIFrameElement | null;
              if (el) { const s = el.src; el.src = ""; el.src = s; }
            }}
            className="text-[10px] text-[var(--text3)] hover:text-[var(--text)] px-2 py-1 rounded transition-colors"
            title="Reload">
            ↻
          </button>
        )}
        <button
          onClick={onToggleSettings}
          className={`text-[10px] px-2.5 py-1 rounded transition-all ${showSettings ? "text-[var(--text)] bg-[var(--border)]" : "text-[var(--text3)] hover:text-[var(--text)]"}`}>
          {showSettings ? "✕ Close" : "⚙ Configure"}
        </button>
      </div>

      {/* Settings drawer */}
      {showSettings && (
        <div className="flex-shrink-0 border-b border-[var(--border)] px-5 py-4"
          style={{ background: "var(--bg2)" }}>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="col-span-2">
              <label className={labelCls}>Grafana URL</label>
              <input
                type="url"
                placeholder="http://192.168.1.100:3000/d/abc123/my-dashboard"
                value={draft.url}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Auto-refresh</label>
              <select
                value={draft.autoRefresh}
                onChange={(e) => setDraft((d) => ({ ...d, autoRefresh: e.target.value }))}
                className={inputCls}>
                <option value="">Off</option>
                <option value="5s">5 seconds</option>
                <option value="30s">30 seconds</option>
                <option value="1m">1 minute</option>
                <option value="5m">5 minutes</option>
                <option value="15m">15 minutes</option>
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="relative inline-flex items-center">
                <input type="checkbox" className="sr-only" checked={draft.kiosk}
                  onChange={(e) => setDraft((d) => ({ ...d, kiosk: e.target.checked }))} />
                <div className="w-8 h-4 rounded-full transition-colors"
                  style={{ background: draft.kiosk ? "#00c8a8" : "var(--border)" }}>
                  <div className="w-3 h-3 rounded-full bg-white transition-transform mt-0.5"
                    style={{ transform: draft.kiosk ? "translateX(17px)" : "translateX(2px)" }} />
                </div>
              </span>
              <span className="text-[11px] text-[var(--text2)]">Kiosk mode (hides Grafana navigation)</span>
            </label>
            <div className="flex gap-2">
              <button onClick={onToggleSettings}
                className="px-3 py-1.5 rounded-lg text-[11px] text-[var(--text3)] hover:text-[var(--text)] transition-colors"
                style={{ border: "1px solid var(--border)" }}>
                Cancel
              </button>
              <button onClick={handleSave}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
                style={{ background: "#00c8a8", color: "#000" }}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 relative overflow-hidden">
        {!config.url ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-8">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{ background: "#f59e0b10", border: "1px solid #f59e0b20" }}>
              <span className="text-[#f59e0b] text-xl font-bold">G</span>
            </div>
            <div>
              <p className="text-[var(--text)] font-semibold mb-1">No Grafana dashboard configured</p>
              <p className="text-[var(--text3)] text-sm max-w-xs">
                Paste the URL of any Grafana dashboard to embed it here. Works with local instances on the same network.
              </p>
            </div>
            <button onClick={onToggleSettings}
              className="px-4 py-2 rounded-xl text-sm font-semibold"
              style={{ background: "#f59e0b", color: "#000" }}>
              Configure Dashboard
            </button>
          </div>
        ) : (
          <iframe
            id="grafana-iframe"
            src={iframeUrl}
            className="absolute inset-0 w-full h-full border-0"
            title="Grafana Dashboard"
            // allow="fullscreen" removed intentionally — Tauri's CSP controls this
          />
        )}
      </div>
    </div>
  );
}

// ── AuditPanel ────────────────────────────────────────────────────────────────

function AuditPanel({
  entries,
  hostId,
  onClear,
}: {
  entries: AuditEntry[];
  hostId: string;
  onClear: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const filtered = filter.trim()
    ? entries.filter((e) => e.command.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  function exportLog() {
    const lines = [...entries].reverse().map((e) =>
      `${new Date(e.ts).toISOString()}  ${e.username}@${e.host}  ${e.command}`
    );
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pingnet-audit-${hostId}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <div className="absolute inset-0 flex flex-col" style={{ background: "var(--bg)" }}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] flex-shrink-0"
        style={{ background: "var(--bg1)" }}>
        <input
          type="text"
          placeholder="Filter commands…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 bg-[var(--bg3)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text4)] focus:outline-none focus:border-[#6366f1] transition-colors font-mono"
        />
        <span className="text-[11px] text-[var(--text4)]">{entries.length} entries</span>
        <button
          onClick={exportLog}
          disabled={entries.length === 0}
          className="text-[11px] font-medium px-3 py-1.5 rounded-lg transition-all disabled:opacity-30"
          style={{ color: "#00c8a8", background: "#00c8a812", border: "1px solid #00c8a830" }}
        >
          ↓ Export
        </button>
        {confirmClear ? (
          <>
            <button
              onClick={() => { onClear(); setConfirmClear(false); }}
              className="text-[11px] font-medium px-3 py-1.5 rounded-lg transition-all"
              style={{ color: "#ef4444", background: "#ef444412", border: "1px solid #ef444430" }}
            >
              Confirm clear
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="text-[11px] font-medium px-3 py-1.5 rounded-lg text-[var(--text3)] hover:text-[var(--text)] transition-all border border-[var(--border)]"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            disabled={entries.length === 0}
            className="text-[11px] font-medium px-3 py-1.5 rounded-lg text-[var(--text3)] hover:text-[#ef4444] transition-all disabled:opacity-30 border border-[var(--border)]"
          >
            Clear
          </button>
        )}
      </div>

      {/* Log entries */}
      {entries.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--text4)]">
          <p className="text-sm">No commands logged yet</p>
          <p className="text-[12px] text-[var(--text5)]">Every command you run in the terminal is recorded here</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto font-mono text-[12px]">
          <table className="w-full border-collapse">
            <thead className="sticky top-0" style={{ background: "var(--bg1)" }}>
              <tr className="text-left border-b border-[var(--border)]">
                <th className="px-4 py-2 text-[10px] font-semibold tracking-widest uppercase text-[var(--text4)] w-44">Time</th>
                <th className="px-4 py-2 text-[10px] font-semibold tracking-widest uppercase text-[var(--text4)] w-28">User</th>
                <th className="px-4 py-2 text-[10px] font-semibold tracking-widest uppercase text-[var(--text4)]">Command</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr
                  key={i}
                  className="border-b border-[var(--bg2)] hover:bg-[var(--bg2)] transition-colors"
                >
                  <td className="px-4 py-2 text-[var(--text4)] whitespace-nowrap">
                    {new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    <span className="ml-1.5 text-[10px] text-[var(--text5)]">
                      {new Date(e.ts).toLocaleDateString([], { month: "short", day: "numeric" })}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-[var(--text3)] whitespace-nowrap">{e.username}</td>
                  <td className="px-4 py-2 text-[#c9d1d9] break-all">{e.command}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-[var(--text4)]">No commands match "{filter}"</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
