import { useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CommandEntry } from "../../types";

// ── Built-in descriptions for common tools ─────────────────────────────────
const TOOL_DESC: Record<string, string> = {
  git:       "Distributed version control",
  docker:    "Container platform",
  kubectl:   "Kubernetes cluster management",
  k9s:       "Kubernetes TUI",
  helm:      "Kubernetes package manager",
  terraform: "Infrastructure as code",
  ansible:   "IT automation",
  npm:       "Node.js package manager",
  yarn:      "Fast JS package manager",
  pnpm:      "Efficient Node.js package manager",
  bun:       "Fast JS runtime & package manager",
  node:      "Node.js runtime",
  npx:       "Run npm packages",
  pip:       "Python package installer",
  pip3:      "Python 3 package installer",
  python:    "Python interpreter",
  python3:   "Python 3 interpreter",
  uv:        "Ultra-fast Python package manager",
  cargo:     "Rust package manager",
  rustc:     "Rust compiler",
  go:        "Go compiler & tools",
  make:      "Build automation",
  cmake:     "Cross-platform build system",
  gradle:    "Build automation (JVM)",
  mvn:       "Maven build tool",
  ssh:       "Secure Shell client",
  scp:       "Secure copy",
  rsync:     "Remote file synchronisation",
  curl:      "HTTP / URL transfer tool",
  wget:      "Network downloader",
  jq:        "JSON processor",
  yq:        "YAML / JSON processor",
  sed:       "Stream editor",
  awk:       "Pattern scanning & processing",
  grep:      "Search file contents",
  rg:        "Fast file content search (ripgrep)",
  find:      "Search for files",
  ls:        "List directory contents",
  cp:        "Copy files",
  mv:        "Move / rename files",
  rm:        "Remove files",
  mkdir:     "Create directories",
  cat:       "Concatenate & print files",
  less:      "View file contents page by page",
  tail:      "Print last N lines of file",
  head:      "Print first N lines of file",
  vim:       "Modal text editor",
  nvim:      "Neovim — modern Vim fork",
  nano:      "Simple terminal text editor",
  ps:        "Report process status",
  top:       "Display running processes",
  htop:      "Interactive process viewer",
  kill:      "Send signal to process",
  pkill:     "Signal processes by name",
  systemctl: "Control systemd services",
  journalctl:"Query systemd journal",
  apt:       "Package manager (Debian/Ubuntu)",
  "apt-get": "Package manager (Debian/Ubuntu)",
  yum:       "Package manager (RHEL/CentOS)",
  dnf:       "Package manager (Fedora)",
  brew:      "macOS / Linux package manager",
  service:   "Control SysV init services",
  nginx:     "Web server & reverse proxy",
  mysql:     "MySQL client",
  psql:      "PostgreSQL client",
  "redis-cli": "Redis client",
  mongo:     "MongoDB shell",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

// ── Props ─────────────────────────────────────────────────────────────────

interface Props {
  commands: CommandEntry[];
  activeSessionId: string | null;
  onClear?: () => void;
  /** Called after a command is sent — use to switch back to the terminal tab */
  onRun?: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function CommandHistory({ commands, activeSessionId, onClear: _onClear, onRun }: Props) {
  const [search, setSearch] = useState("");
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [sentCmd, setSentCmd] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(c =>
      c.command.toLowerCase().includes(q) ||
      c.base_cmd.toLowerCase().includes(q)
    );
  }, [commands, search]);

  // Group by base_cmd for display
  const grouped = useMemo(() => {
    const map = new Map<string, CommandEntry[]>();
    for (const c of filtered) {
      const arr = map.get(c.base_cmd) ?? [];
      arr.push(c);
      map.set(c.base_cmd, arr);
    }
    // Sort groups by most-recent command in each group
    return [...map.entries()].sort((a, b) => {
      const aMax = Math.max(...a[1].map(c => c.last_seen));
      const bMax = Math.max(...b[1].map(c => c.last_seen));
      return bMax - aMax;
    });
  }, [filtered]);

  const insertCmd = async (cmd: string) => {
    if (!activeSessionId) return;
    await invoke("ssh_send", { sessionId: activeSessionId, data: cmd + "\r" }).catch(() => {});
    // Show brief "sent" flash, then switch to terminal tab
    setSentCmd(cmd);
    setTimeout(() => {
      setSentCmd(null);
      onRun?.();
    }, 600);
  };

  const copyCmd = async (cmd: string) => {
    await navigator.clipboard.writeText(cmd);
    setCopiedCmd(cmd);
    setTimeout(() => setCopiedCmd(null), 1500);
  };

  return (
    <div className="flex flex-col h-full" style={{ background: "#08080f" }}>

      {/* Header + search */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-[#1e1e35]">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-white font-semibold text-sm">Command History</p>
            <p className="text-[#374151] text-[11px] mt-0.5">
              {commands.length} command{commands.length !== 1 ? "s" : ""} saved across{" "}
              {new Set(commands.map(c => c.base_cmd)).size} tools
            </p>
          </div>
          {commands.length > 0 && activeSessionId && (
            <span className="text-[11px] text-[#374151]">click → run in terminal</span>
          )}
        </div>

        {/* Search */}
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="5" cy="5" r="3.5" stroke="#374151" strokeWidth="1.2" />
            <path d="M8 8l2.5 2.5" stroke="#374151" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search commands…"
            className="w-full pl-8 pr-3 py-2 rounded-lg text-[12px] text-white placeholder-[#2d3748] outline-none border border-[#1e1e35] focus:border-[#6366f150] transition-colors"
            style={{ background: "#0f0f1a" }}
          />
          {search && (
            <button onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#374151] hover:text-white transition-colors">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {commands.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: "#6366f110", border: "1px solid #6366f120" }}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="1.5" y="3" width="15" height="12" rx="2" stroke="#6366f1" strokeWidth="1.2" />
                <path d="M4 7.5l2 2L4 11.5" stroke="#6366f1" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M8 11.5h5" stroke="#6366f1" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <p className="text-white text-sm font-medium mb-1">No history yet</p>
              <p className="text-[#374151] text-[12px]">
                Commands you run will be saved here so you never lose them between sessions.
              </p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-[#374151] text-sm">
            No commands match "{search}"
          </div>
        ) : (
          <div className="py-2">
            {grouped.map(([base, entries]) => (
              <ToolGroup
                key={base}
                base={base}
                entries={entries}
                copiedCmd={copiedCmd}
                sentCmd={sentCmd}
                onInsert={activeSessionId ? insertCmd : undefined}
                onCopy={copyCmd}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── ToolGroup ──────────────────────────────────────────────────────────────

interface GroupProps {
  base: string;
  entries: CommandEntry[];
  copiedCmd: string | null;
  sentCmd: string | null;
  onInsert?: (cmd: string) => void;
  onCopy: (cmd: string) => void;
}

function ToolGroup({ base, entries, copiedCmd, sentCmd, onInsert, onCopy }: GroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const desc = entries[0].help_summary ?? TOOL_DESC[base] ?? null;
  const totalRuns = entries.reduce((sum, e) => sum + e.count, 0);
  const lastUsed = Math.max(...entries.map(e => e.last_seen));

  return (
    <div className="mb-1">
      {/* Group header */}
      <button
        onClick={() => setCollapsed(p => !p)}
        className="w-full flex items-center gap-2 px-4 py-2 hover:bg-[#0f0f1a] transition-colors text-left"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}>
          <path d="M2 3.5l3 3 3-3" stroke="#4b5563" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        <span className="font-mono text-[13px] font-semibold text-[#818cf8]">{base}</span>
        {desc && <span className="text-[11px] text-[#374151] truncate flex-1">{desc}</span>}
        <span className="flex-shrink-0 text-[10px] text-[#2d3748]">
          {totalRuns}× · {fmtRelative(lastUsed)}
        </span>
      </button>

      {/* Commands under this tool */}
      {!collapsed && entries.map(entry => (
        <CommandRow
          key={entry.command}
          entry={entry}
          copiedCmd={copiedCmd}
          sentCmd={sentCmd}
          onInsert={onInsert}
          onCopy={onCopy}
        />
      ))}
    </div>
  );
}

// ── CommandRow ─────────────────────────────────────────────────────────────

interface RowProps {
  entry: CommandEntry;
  copiedCmd: string | null;
  sentCmd: string | null;
  onInsert?: (cmd: string) => void;
  onCopy: (cmd: string) => void;
}

function CommandRow({ entry, copiedCmd, sentCmd, onInsert, onCopy }: RowProps) {
  const isCopied = copiedCmd === entry.command;
  const isSent   = sentCmd   === entry.command;

  return (
    <div
      className="group flex items-center gap-2 px-4 py-2 transition-colors cursor-pointer"
      style={{ background: isSent ? "#1a1f35" : undefined }}
      onClick={() => onInsert?.(entry.command)}
      title={onInsert ? "Click to run in terminal" : "Connect a terminal first"}
    >
      {/* Indent mark */}
      <div className="w-px h-4 bg-[#1e1e35] ml-3 flex-shrink-0" />

      {/* Command text */}
      <span className="flex-1 font-mono text-[12px] text-[#e2e8f0] truncate">
        {entry.command}
      </span>

      {/* Run count badge */}
      {entry.count > 1 && (
        <span className="flex-shrink-0 text-[10px] text-[#374151] px-1.5 py-0.5 rounded-md"
          style={{ background: "#1e1e35" }}>
          {entry.count}×
        </span>
      )}

      {/* Actions — visible on hover */}
      <div className="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {/* Copy */}
        <button
          onClick={e => { e.stopPropagation(); onCopy(entry.command); }}
          className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-[#1e1e35] transition-colors"
          title="Copy to clipboard"
        >
          {isCopied ? (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M1.5 5.5l3 3 5-6" stroke="#22c55e" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <rect x="1" y="3" width="7" height="7" rx="1" stroke="#4b5563" strokeWidth="1" />
              <path d="M3 3V2a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H7" stroke="#4b5563" strokeWidth="1" />
            </svg>
          )}
        </button>

        {/* Run */}
        {onInsert && (
          <button
            onClick={e => { e.stopPropagation(); onInsert(entry.command); }}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-[#1e1e35] transition-colors"
            title="Run in terminal"
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M2 2l7 3.5L2 9V2z" fill="#6366f1" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
