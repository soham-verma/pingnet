import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SSHTerminal from "./ssh/SSHTerminal";
import {
  getTerminalTheme,
  readTerminalThemeId,
  saveTerminalThemeId,
  TERMINAL_THEMES,
} from "../utils/terminalThemes";

// ── Types ─────────────────────────────────────────────────────────────────────

type TabStatus = "starting" | "running" | "exited";

interface LocalTab {
  id: string;
  name: string;
  status: TabStatus;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return crypto.randomUUID(); }

function defaultName(existing: LocalTab[]) {
  return `Shell ${existing.length + 1}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LocalTerminalView() {
  const [tabs, setTabs] = useState<LocalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [terminalThemeId, setTerminalThemeId] = useState(readTerminalThemeId);

  // unlisten functions keyed by tab ID
  const unlistenMap = useRef<Map<string, () => void>>(new Map());

  const setTabStatus = (id: string, status: TabStatus) =>
    setTabs(prev => prev.map(t => t.id === id ? { ...t, status } : t));

  // ── Listen for shell exit ──────────────────────────────────────────────────

  const registerExitListener = async (tabId: string) => {
    unlistenMap.current.get(tabId)?.();
    const unlisten = await listen(`ssh-closed-${tabId}`, () => {
      setTabStatus(tabId, "exited");
    });
    unlistenMap.current.set(tabId, unlisten);
  };

  // ── Start a shell tab ──────────────────────────────────────────────────────

  const startTab = useCallback(async (tabId: string) => {
    try {
      await invoke("local_pty_start", { sessionId: tabId });
      setTabStatus(tabId, "running");
      await registerExitListener(tabId);
    } catch (e) {
      console.error("[LocalTerminal] start failed:", e);
      setTabStatus(tabId, "exited");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Add / close tabs ───────────────────────────────────────────────────────

  const addTab = useCallback(async () => {
    const id = uid();
    setTabs(prev => [...prev, { id, name: defaultName(prev), status: "starting" }]);
    setActiveTabId(id);
    await startTab(id);
  }, [startTab]);

  const closeTab = useCallback(async (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    unlistenMap.current.get(tabId)?.();
    unlistenMap.current.delete(tabId);
    try { await invoke("local_pty_stop", { sessionId: tabId }); } catch {}

    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId) setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }, [activeTabId]);

  // Open one shell automatically on mount
  useEffect(() => {
    addTab();
    return () => {
      unlistenMap.current.forEach(fn => fn());
      unlistenMap.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleThemeChange = useCallback((id: string) => {
    setTerminalThemeId(id);
    saveTerminalThemeId(id);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border)] flex-shrink-0"
        style={{ background: "var(--bg1)" }}>

        <div className="w-6 h-6 flex items-center justify-center rounded-md flex-shrink-0"
          style={{ background: "#00c8a815", border: "1px solid #00c8a825" }}>
          {/* Terminal icon */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="0.5" y="1.5" width="11" height="9" rx="1.5" stroke="#00c8a8" strokeWidth="1"/>
            <path d="M2 5.5L4 4L2 2.5" stroke="#00c8a8" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M5 5.5H8" stroke="#00c8a8" strokeWidth="1" strokeLinecap="round"/>
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <span className="text-[var(--text)] font-semibold text-sm">Local Terminal</span>
          <div className="text-[11px] text-[var(--text4)] mt-0.5">
            your machine
          </div>
        </div>

        {/* Theme picker */}
        <div className="flex items-center gap-1.5">
          <span
            className="w-3 h-3 rounded-sm flex-shrink-0 border border-white/10"
            style={{ background: getTerminalTheme(terminalThemeId).xterm.background }}
          />
          <select
            value={terminalThemeId}
            onChange={e => handleThemeChange(e.target.value)}
            className="h-7 max-w-[120px] rounded px-1.5 text-[11px] font-medium bg-[var(--bg2)] border border-[var(--border)] text-[var(--text2)] focus:outline-none focus:border-[#00c8a860] cursor-pointer"
          >
            {TERMINAL_THEMES.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden relative">
        {tabs.length === 0 ? (
          <EmptyState onOpen={addTab} />
        ) : (
          <div className="absolute inset-0 flex flex-col">
            {/* Terminal panes — each mounted persistently, shown/hidden by CSS */}
            <div className="flex-1 min-h-0 relative">
              {tabs.map(tab => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{
                    display: tab.id === activeTabId ? "block" : "none",
                    background: getTerminalTheme(terminalThemeId).xterm.background,
                  }}
                >
                  {tab.status === "starting" ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3">
                      <div className="relative w-10 h-10">
                        <div className="absolute inset-0 rounded-full border-2 border-[var(--border)]" />
                        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#00c8a8] animate-spin" />
                      </div>
                      <p className="text-[var(--text3)] text-sm">Starting shell…</p>
                    </div>
                  ) : tab.status === "exited" ? (
                    <div className="relative h-full">
                      {/* Faded terminal output stays visible underneath */}
                      <div className="absolute inset-0 opacity-40 pointer-events-none">
                        <SSHTerminal
                          sessionId={tab.id}
                          isConnected={false}
                          themeId={terminalThemeId}
                          sendCmd="local_pty_send"
                          resizeCmd="local_pty_resize"
                        />
                      </div>
                      {/* Overlay */}
                      <div className="absolute inset-0 flex items-center justify-center"
                        style={{ background: "rgba(8,8,15,0.75)", backdropFilter: "blur(2px)" }}>
                        <div className="rounded-2xl border border-[var(--border)] p-8 flex flex-col items-center gap-4 max-w-xs w-full mx-4"
                          style={{ background: "var(--bg2)" }}>
                          <div className="w-10 h-10 rounded-full flex items-center justify-center"
                            style={{ background: "#ef444415", border: "1px solid #ef444430" }}>
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                              <circle cx="8" cy="8" r="6.5" stroke="#ef4444" strokeWidth="1.2"/>
                              <path d="M8 4.5v4M8 10.5v.5" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                          </div>
                          <div className="text-center">
                            <p className="text-[var(--text)] font-semibold mb-1">Shell exited</p>
                            <p className="text-[var(--text4)] text-[12px]">The shell process ended</p>
                          </div>
                          <button
                            onClick={() => { setTabStatus(tab.id, "starting"); startTab(tab.id); }}
                            className="w-full py-2 rounded-xl text-sm font-semibold transition-all"
                            style={{ background: "#00c8a8", color: "#000" }}
                          >
                            New Shell
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <SSHTerminal
                      sessionId={tab.id}
                      isConnected={true}
                      themeId={terminalThemeId}
                      sendCmd="local_pty_send"
                      resizeCmd="local_pty_resize"
                    />
                  )}
                </div>
              ))}
            </div>

            {/* Tab bar */}
            <div
              className="flex items-center border-t border-[var(--border)] flex-shrink-0 overflow-x-auto"
              style={{ background: "var(--bg1)", minHeight: 36 }}
            >
              {tabs.map(tab => {
                const isActive = tab.id === activeTabId;
                const dotColor = tab.status === "running" ? "#00c8a8"
                  : tab.status === "exited" ? "#ef4444"
                  : "#f59e0b";
                return (
                  <div
                    key={tab.id}
                    onClick={() => setActiveTabId(tab.id)}
                    className={`group flex items-center gap-1.5 px-3 h-9 border-r border-[var(--border)] cursor-pointer flex-shrink-0 select-none transition-colors ${
                      isActive ? "bg-[var(--bg2)]" : "hover:bg-[var(--bg2)]"
                    }`}
                    style={{ borderTop: isActive ? `2px solid ${dotColor}` : "2px solid transparent" }}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tab.status === "starting" ? "ping-pulsing" : ""}`}
                      style={{ background: dotColor }}
                    />
                    <span className={`text-[12px] font-medium max-w-[120px] truncate ${
                      isActive ? "text-[var(--text)]" : "text-[var(--text3)] group-hover:text-[var(--text2)]"
                    }`}>
                      {tab.name}
                    </span>
                    <button
                      onClick={e => closeTab(tab.id, e)}
                      className={`flex-shrink-0 w-4 h-4 flex items-center justify-center rounded text-[10px] transition-all ${
                        isActive
                          ? "text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] opacity-100"
                          : "text-[var(--text5)] hover:text-[var(--text3)] opacity-0 group-hover:opacity-100"
                      }`}
                    >✕</button>
                  </div>
                );
              })}

              {/* New tab */}
              <button
                onClick={addTab}
                className="h-9 px-3 flex items-center text-[var(--text4)] hover:text-[#00c8a8] hover:bg-[var(--bg2)] transition-all flex-shrink-0"
                title="New shell tab"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── EmptyState ─────────────────────────────────────────────────────────────────

function EmptyState({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <div className="w-14 h-14 flex items-center justify-center rounded-2xl"
        style={{ background: "#00c8a810", border: "1px solid #00c8a820" }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="2" y="5" width="20" height="14" rx="2.5" stroke="#00c8a8" strokeWidth="1.5"/>
          <path d="M6 13l2.5-2.5L6 8" stroke="#00c8a8" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M11 13h5" stroke="#00c8a8" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </div>
      <div className="text-center">
        <p className="text-[var(--text)] font-semibold mb-1">Local Terminal</p>
        <p className="text-[var(--text3)] text-sm">Open a shell on this machine</p>
      </div>
      <button
        onClick={onOpen}
        className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all"
        style={{ background: "#00c8a8", color: "#000", boxShadow: "0 0 16px #00c8a840" }}
      >
        + New Shell
      </button>
    </div>
  );
}
