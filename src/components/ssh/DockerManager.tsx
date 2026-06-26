import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DockerContainer, DockerComposeProject, FileEntry } from "../../types";
import {
  parseContainerState,
  stateColor,
  formatContainerName,
  formatDockerPorts,
  composeStatusCategory,
} from "../../utils/docker";

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  sessionId: string | null;
  isActive: boolean;
  /** Inject a command string into the active SSH terminal shell */
  onSendToTerminal: (cmd: string) => void;
}

type DockerTab = "containers" | "compose" | "logs" | "system";

// ── Helpers ───────────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: string }) {
  const color = stateColor(state);
  const cat = parseContainerState(state);
  const label = cat === "other" ? state : cat;
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize"
      style={{ color, background: `${color}18`, border: `1px solid ${color}30` }}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cat === "running" ? "animate-pulse" : ""}`}
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function ActionBtn({
  label,
  onClick,
  danger = false,
  disabled = false,
  loading = false,
  title,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      className="px-2.5 py-1 rounded text-[11px] font-medium transition-all disabled:opacity-40"
      style={
        danger
          ? { color: "#f87171", background: "#f8717112", border: "1px solid #f8717130" }
          : { color: "var(--text2)", background: "var(--bg3)", border: "1px solid var(--border)" }
      }
      onMouseEnter={(e) => {
        if (!disabled && !loading) {
          (e.currentTarget as HTMLElement).style.color = danger ? "#ef4444" : "var(--text)";
          (e.currentTarget as HTMLElement).style.background = danger ? "#ef444418" : "var(--bg4)";
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.color = danger ? "#f87171" : "var(--text2)";
        (e.currentTarget as HTMLElement).style.background = danger ? "#f8717112" : "var(--bg3)";
      }}
    >
      {loading ? "…" : label}
    </button>
  );
}

function OutputDrawer({
  title,
  output,
  onClose,
}: {
  title: string;
  output: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [output]);

  return (
    <div
      className="absolute bottom-0 left-0 right-0 flex flex-col border-t"
      style={{
        maxHeight: "45%",
        background: "var(--bg)",
        borderColor: "var(--border2)",
        zIndex: 10,
      }}
    >
      <div
        className="flex items-center gap-2 px-4 py-2 border-b flex-shrink-0"
        style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
      >
        <span className="text-[11px] font-semibold text-[var(--text)] flex-1 truncate">
          {title}
        </span>
        <button
          onClick={onClose}
          className="text-[var(--text4)] hover:text-[var(--text)] text-[12px] transition-colors"
        >
          ✕
        </button>
      </div>
      <div
        ref={ref}
        className="flex-1 overflow-y-auto p-3 font-mono text-[11px] text-[#c9d1d9] whitespace-pre-wrap"
        style={{ background: "var(--bg)" }}
      >
        {output || "(no output)"}
      </div>
    </div>
  );
}

// ── Sudo detection & modal ────────────────────────────────────────────────────

/** Returns true when an error string indicates Docker needs root/sudo access */
function isPermissionDenied(err: string): boolean {
  const lower = err.toLowerCase();
  return (
    lower === "permission_denied" ||
    lower.includes("permission denied") ||
    lower.includes("got permission denied while trying to connect") ||
    lower.includes("connect: permission denied")
  );
}

function SudoModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (pw: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => { if (pw) onConfirm(pw); };

  return (
    <div
      className="absolute inset-0 flex items-center justify-center z-20"
      style={{ background: "rgba(8,8,15,0.82)", backdropFilter: "blur(3px)" }}
    >
      <div
        className="rounded-2xl border p-6 flex flex-col gap-4 w-[340px] shadow-2xl"
        style={{ background: "var(--bg2)", borderColor: "var(--border2)" }}
      >
        {/* Icon */}
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "#f59e0b10", border: "1px solid #f59e0b30" }}
          >
            <span className="text-[#f59e0b] text-base">🔐</span>
          </div>
          <div>
            <p className="text-[var(--text)] font-semibold text-sm">sudo required</p>
            <p className="text-[11px] text-[var(--text3)]">
              Docker needs elevated permissions on this host
            </p>
          </div>
        </div>

        {/* Explanation */}
        <p className="text-[12px] text-[var(--text3)] leading-relaxed">
          The current user is not in the <span className="font-mono text-[var(--text2)]">docker</span> group.
          Enter the sudo password to run Docker commands as root.
          The password is sent over the existing encrypted SSH session and never stored.
        </p>

        {/* Password input */}
        <input
          ref={inputRef}
          type="password"
          placeholder="sudo password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); }}
          className="w-full bg-[var(--bg3)] border border-[var(--border)] rounded-lg px-3 py-2 text-[13px] text-[var(--text)] placeholder-[var(--text4)] focus:outline-none focus:border-[#f59e0b60] font-mono"
        />

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-xl text-[12px] font-medium text-[var(--text3)] hover:text-[var(--text)] transition-colors border border-[var(--border)]"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!pw}
            className="flex-1 py-2 rounded-xl text-[12px] font-semibold transition-all disabled:opacity-40"
            style={{ background: "#f59e0b", color: "#000" }}
          >
            Use sudo
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Remote file picker ────────────────────────────────────────────────────────

function ComposeFilePicker({
  sessionId,
  currentPath,
  onSelect,
  onClose,
}: {
  sessionId: string;
  currentPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [dir, setDir] = useState(() => {
    // Start in the directory of the current file, or home
    if (currentPath) {
      const parts = currentPath.split("/");
      parts.pop();
      return parts.join("/") || "/";
    }
    return "/home";
  });
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(currentPath || null);

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<FileEntry[]>("sftp_list", { sessionId, path });
      // Sort: dirs first, then files; alphabetical within each group
      list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(list);
      setDir(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { loadDir(dir); }, []);

  const navigate = (entry: FileEntry) => {
    if (entry.is_dir) {
      loadDir(entry.path);
    } else {
      setSelected(entry.path);
    }
  };

  const goUp = () => {
    const parts = dir.split("/").filter(Boolean);
    parts.pop();
    loadDir("/" + parts.join("/") || "/");
  };

  const isYaml = (name: string) =>
    name.endsWith(".yml") || name.endsWith(".yaml");

  const isComposeFile = (name: string) =>
    isYaml(name) && (name.includes("compose") || name === "docker-compose.yml");

  // Breadcrumb segments
  const breadcrumbs = ["", ...dir.split("/").filter(Boolean)];

  return (
    <div
      className="absolute inset-0 flex items-center justify-center z-30"
      style={{ background: "rgba(8,8,15,0.85)", backdropFilter: "blur(3px)" }}
    >
      <div
        className="flex flex-col rounded-2xl border shadow-2xl overflow-hidden"
        style={{
          width: "min(560px, 90vw)",
          maxHeight: "70vh",
          background: "var(--bg2)",
          borderColor: "var(--border2)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-4 py-3 border-b flex-shrink-0"
          style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
        >
          <span className="text-[12px] font-semibold text-[var(--text)]">Browse compose files</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="text-[var(--text4)] hover:text-[var(--text)] text-[12px] transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Breadcrumb */}
        <div
          className="flex items-center gap-1 px-3 py-2 border-b flex-shrink-0 overflow-x-auto"
          style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
        >
          {breadcrumbs.map((seg, i) => {
            const path = "/" + breadcrumbs.slice(1, i + 1).join("/");
            const isLast = i === breadcrumbs.length - 1;
            return (
              <span key={i} className="flex items-center gap-1 flex-shrink-0">
                {i > 0 && <span className="text-[var(--text5)] text-[10px]">/</span>}
                <button
                  onClick={() => !isLast && loadDir(path || "/")}
                  className={`text-[11px] font-mono px-1 py-0.5 rounded transition-colors ${
                    isLast
                      ? "text-[var(--text)] font-semibold"
                      : "text-[var(--text4)] hover:text-[#6366f1]"
                  }`}
                >
                  {seg || "/"}
                </button>
              </span>
            );
          })}
          {loading && (
            <span className="text-[10px] text-[var(--text4)] ml-2 animate-pulse">loading…</span>
          )}
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {error ? (
            <div className="flex items-center justify-center h-full text-[12px] text-[#6b3333] px-4 text-center">
              {error}
            </div>
          ) : (
            <div>
              {/* Up button */}
              {dir !== "/" && (
                <button
                  onClick={goUp}
                  className="w-full flex items-center gap-2 px-4 py-2 text-[12px] text-[var(--text3)] hover:bg-[var(--bg3)] transition-colors border-b border-[var(--bg1)]"
                >
                  <span className="text-base">↑</span>
                  <span className="font-mono">..</span>
                </button>
              )}
              {entries.map((entry) => {
                const isDir = entry.is_dir;
                const yaml = isYaml(entry.name);
                const compose = isComposeFile(entry.name);
                const isSel = selected === entry.path;

                return (
                  <button
                    key={entry.path}
                    onClick={() => navigate(entry)}
                    className="w-full flex items-center gap-2 px-4 py-2 text-left transition-colors border-b border-[var(--bg1)]"
                    style={{
                      background: isSel ? "#6366f115" : undefined,
                    }}
                    onMouseEnter={(e) => { if (!isSel) (e.currentTarget as HTMLElement).style.background = "var(--bg3)"; }}
                    onMouseLeave={(e) => { if (!isSel) (e.currentTarget as HTMLElement).style.background = ""; }}
                  >
                    {/* Icon */}
                    <span className="text-base flex-shrink-0">
                      {isDir ? "📁" : compose ? "🐙" : yaml ? "📄" : "·"}
                    </span>
                    {/* Name */}
                    <span
                      className="text-[12px] font-mono flex-1 truncate"
                      style={{
                        color: isDir
                          ? "var(--text)"
                          : compose
                          ? "#00c8a8"
                          : yaml
                          ? "var(--text2)"
                          : "var(--text4)",
                      }}
                    >
                      {entry.name}
                      {isDir ? "/" : ""}
                    </span>
                    {/* Size for files */}
                    {!isDir && (
                      <span className="text-[10px] text-[var(--text4)] ml-2 flex-shrink-0">
                        {entry.size < 1024
                          ? `${entry.size}B`
                          : `${Math.round(entry.size / 1024)}KB`}
                      </span>
                    )}
                    {isSel && (
                      <span className="text-[10px] text-[#6366f1] font-semibold ml-1">✓</span>
                    )}
                  </button>
                );
              })}
              {entries.length === 0 && !loading && (
                <p className="text-center text-[12px] text-[var(--text4)] py-8">Empty directory</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center gap-2 px-4 py-3 border-t flex-shrink-0"
          style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
        >
          <span
            className="flex-1 text-[11px] font-mono truncate"
            style={{ color: selected ? "var(--text2)" : "var(--text4)" }}
          >
            {selected || "No file selected"}
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-[11px] text-[var(--text3)] border border-[var(--border)] hover:text-[var(--text)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => selected && onSelect(selected)}
            disabled={!selected || entries.find(e => e.path === selected)?.is_dir}
            className="px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-40"
            style={{ background: "#6366f1", color: "#fff" }}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Containers tab ────────────────────────────────────────────────────────────

function ContainersTab({
  sessionId,
  onSendToTerminal,
  onViewLogs,
}: {
  sessionId: string;
  onSendToTerminal: (cmd: string) => void;
  onViewLogs: (containerId: string) => void;
}) {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<{ title: string; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchContainers = useCallback(async () => {
    try {
      const list = await invoke<DockerContainer[]>("docker_list_containers", { sessionId });
      setContainers(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchContainers().finally(() => setLoading(false));
  }, [fetchContainers]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(fetchContainers, 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, fetchContainers]);

  const runAction = async (containerId: string, action: string, name: string) => {
    const key = `${containerId}:${action}`;
    setActionRunning(key);
    try {
      const out = await invoke<string>("docker_container_action", { sessionId, containerId, action });
      if (out) setLastOutput({ title: `docker ${action} ${name}`, text: out });
      await fetchContainers();
    } catch (e) {
      setLastOutput({ title: `docker ${action} ${name} — ERROR`, text: String(e) });
    } finally {
      setActionRunning(null);
    }
  };

  const filtered = filter.trim()
    ? containers.filter(
        (c) =>
          formatContainerName(c.names).toLowerCase().includes(filter.toLowerCase()) ||
          c.image.toLowerCase().includes(filter.toLowerCase())
      )
    : containers;

  const running = containers.filter((c) => parseContainerState(c.state) === "running").length;

  return (
    <div className="absolute inset-0 flex flex-col" style={{ background: "var(--bg)" }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b flex-shrink-0"
        style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
      >
        <input
          type="text"
          placeholder="Filter by name or image…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 bg-[var(--bg3)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text4)] focus:outline-none focus:border-[#6366f1] transition-colors font-mono"
        />
        <span className="text-[11px] text-[var(--text4)] whitespace-nowrap">
          {running}/{containers.length} running
        </span>
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <span
            className="relative inline-flex items-center"
            onClick={() => setAutoRefresh((v) => !v)}
          >
            <div
              className="w-7 h-3.5 rounded-full transition-colors"
              style={{ background: autoRefresh ? "#00c8a8" : "var(--border)" }}
            >
              <div
                className="w-3 h-3 rounded-full bg-white transition-transform mt-0.5"
                style={{ transform: autoRefresh ? "translateX(15px)" : "translateX(2px)" }}
              />
            </div>
          </span>
          <span className="text-[11px] text-[var(--text3)]">Auto</span>
        </label>
        <button
          onClick={() => { setLoading(true); fetchContainers().finally(() => setLoading(false)); }}
          disabled={loading}
          className="text-[11px] px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-40"
          style={{ color: "#00c8a8", background: "#00c8a812", border: "1px solid #00c8a830" }}
        >
          {loading ? "…" : "↻ Refresh"}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto relative">
        {error ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-8">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: "#ef444410", border: "1px solid #ef444425" }}
            >
              <span className="text-[#ef4444] text-lg">🐳</span>
            </div>
            <div className="text-center">
              <p className="text-[var(--text)] font-semibold mb-1">Docker unavailable</p>
              <p className="text-[#6b3333] text-[12px] font-mono break-words max-w-xs">{error}</p>
            </div>
          </div>
        ) : filtered.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text4)]">
            <span className="text-3xl">🐳</span>
            <p className="text-sm">{filter ? `No containers match "${filter}"` : "No containers found"}</p>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0" style={{ background: "var(--bg1)" }}>
              <tr className="text-left border-b border-[var(--border)]">
                {["Name", "Image", "Status", "Ports", "Actions"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2.5 text-[10px] font-semibold tracking-widest uppercase text-[var(--text4)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const name = formatContainerName(c.names);
                const cat = parseContainerState(c.state);
                const isRunning = cat === "running";
                const actionKey = (a: string) => `${c.id}:${a}`;
                const busy = (a: string) => actionRunning === actionKey(a);

                return (
                  <tr
                    key={c.id}
                    className="border-b border-[var(--bg2)] hover:bg-[var(--bg2)] transition-colors"
                  >
                    {/* Name */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <StateBadge state={c.state} />
                        <span
                          className="text-[12px] font-mono text-[var(--text)] font-medium truncate max-w-[140px]"
                          title={name}
                        >
                          {name}
                        </span>
                      </div>
                    </td>
                    {/* Image */}
                    <td className="px-4 py-2.5 text-[11px] font-mono text-[var(--text3)] max-w-[180px]">
                      <span className="truncate block" title={c.image}>
                        {c.image}
                      </span>
                    </td>
                    {/* Status */}
                    <td className="px-4 py-2.5 text-[11px] text-[var(--text3)] whitespace-nowrap">
                      {c.status}
                    </td>
                    {/* Ports */}
                    <td className="px-4 py-2.5 text-[11px] font-mono text-[var(--text4)] max-w-[160px]">
                      <span title={c.ports}>{formatDockerPorts(c.ports)}</span>
                    </td>
                    {/* Actions */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1 flex-wrap">
                        {isRunning ? (
                          <>
                            <ActionBtn
                              label="Stop"
                              onClick={() => runAction(c.id, "stop", name)}
                              loading={busy("stop")}
                              disabled={!!actionRunning}
                            />
                            <ActionBtn
                              label="Restart"
                              onClick={() => runAction(c.id, "restart", name)}
                              loading={busy("restart")}
                              disabled={!!actionRunning}
                            />
                            <ActionBtn
                              label="Logs"
                              onClick={() => onViewLogs(c.id)}
                              title="View logs for this container"
                            />
                            <ActionBtn
                              label="Exec"
                              onClick={() => onSendToTerminal(`docker exec -it ${name} bash || docker exec -it ${name} sh`)}
                              title="Open a shell in this container (runs in terminal)"
                            />
                          </>
                        ) : (
                          <ActionBtn
                            label="Start"
                            onClick={() => runAction(c.id, "start", name)}
                            loading={busy("start")}
                            disabled={!!actionRunning}
                          />
                        )}
                        {confirmRemove === c.id ? (
                          <>
                            <ActionBtn
                              label="Confirm"
                              onClick={() => {
                                setConfirmRemove(null);
                                runAction(c.id, "remove", name);
                              }}
                              danger
                            />
                            <ActionBtn
                              label="Cancel"
                              onClick={() => setConfirmRemove(null)}
                            />
                          </>
                        ) : (
                          <ActionBtn
                            label="Remove"
                            onClick={() => setConfirmRemove(c.id)}
                            danger
                            disabled={!!actionRunning}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Output drawer */}
        {lastOutput && (
          <OutputDrawer
            title={lastOutput.title}
            output={lastOutput.text}
            onClose={() => setLastOutput(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Compose tab ───────────────────────────────────────────────────────────────

function ComposeTab({
  sessionId,
  sudoPassword,
  onPermDenied,
}: {
  sessionId: string;
  sudoPassword: string | null;
  onPermDenied: () => void;
}) {
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [projects, setProjects] = useState<DockerComposeProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<{ title: string; text: string } | null>(null);
  const [customFile, setCustomFile] = useState("");

  const fetchProjects = useCallback(async () => {
    try {
      const list = await invoke<DockerComposeProject[]>("docker_compose_list", {
        sessionId,
        sudoPassword,
      });
      setProjects(list);
      setError(null);
    } catch (e) {
      const msg = String(e);
      if (isPermissionDenied(msg)) { onPermDenied(); setError("sudo required — click 🔐 to enter password"); }
      else setError(msg);
    }
  }, [sessionId, sudoPassword, onPermDenied]);

  useEffect(() => {
    setLoading(true);
    fetchProjects().finally(() => setLoading(false));
  }, [fetchProjects]);

  const runProjectAction = async (
    projectName: string,
    action: string,
    service = ""
  ) => {
    const key = `${projectName}:${service}:${action}`;
    setActionRunning(key);
    try {
      const out = await invoke<string>("docker_compose_action", {
        sessionId,
        projectName,
        composeFile: "",
        service,
        action,
        sudoPassword,
      });
      setLastOutput({
        title: `compose ${action}${service ? ` ${service}` : ""} [${projectName}]`,
        text: out,
      });
      await fetchProjects();
    } catch (e) {
      const msg = String(e);
      if (isPermissionDenied(msg)) { onPermDenied(); setLastOutput({ title: "sudo required", text: "Enter sudo password and try again." }); }
      else setLastOutput({ title: `compose ${action} [${projectName}] — ERROR`, text: msg });
    } finally {
      setActionRunning(null);
    }
  };

  const runCustomFileAction = async (action: string) => {
    if (!customFile.trim()) return;
    setActionRunning(`custom:${action}`);
    try {
      const out = await invoke<string>("docker_compose_action", {
        sessionId,
        projectName: "",
        composeFile: customFile.trim(),
        service: "",
        action,
        sudoPassword,
      });
      setLastOutput({ title: `compose ${action} [${customFile}]`, text: out });
    } catch (e) {
      const msg = String(e);
      if (isPermissionDenied(msg)) { onPermDenied(); setLastOutput({ title: "sudo required", text: "Enter sudo password and try again." }); }
      else setLastOutput({ title: `compose ${action} — ERROR`, text: msg });
    } finally {
      setActionRunning(null);
    }
  };

  const toggleExpanded = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const composeCategoryColor = (status: string) => {
    switch (composeStatusCategory(status)) {
      case "running": return "#22c55e";
      case "partial": return "#f59e0b";
      case "stopped": return "#ef4444";
      default:        return "var(--text4)";
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col" style={{ background: "var(--bg)" }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b flex-shrink-0"
        style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
      >
        <span className="text-[11px] text-[var(--text3)] font-medium">
          {projects.length} project{projects.length !== 1 ? "s" : ""}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => { setLoading(true); fetchProjects().finally(() => setLoading(false)); }}
          disabled={loading}
          className="text-[11px] px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-40"
          style={{ color: "#00c8a8", background: "#00c8a812", border: "1px solid #00c8a830" }}
        >
          {loading ? "…" : "↻ Refresh"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto relative">
        {error ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-8">
            <span className="text-3xl">🐙</span>
            <div className="text-center">
              <p className="text-[var(--text)] font-semibold mb-1">Docker Compose unavailable</p>
              <p className="text-[12px] text-[#6b3333] font-mono max-w-xs">{error}</p>
              <p className="text-[11px] text-[var(--text4)] mt-2">Requires Docker Compose v2 (docker compose plugin)</p>
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {/* Custom compose file */}
            <div
              className="rounded-xl p-4 border"
              style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
            >
              <p className="text-[11px] font-semibold text-[var(--text2)] mb-2">Custom compose file</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="/path/to/docker-compose.yml"
                  value={customFile}
                  onChange={(e) => setCustomFile(e.target.value)}
                  className="flex-1 bg-[var(--bg3)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text4)] focus:outline-none focus:border-[#6366f1] font-mono"
                />
                <button
                  onClick={() => setShowFilePicker(true)}
                  className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
                  style={{ color: "#6366f1", background: "#6366f112", border: "1px solid #6366f130" }}
                >
                  <span>📁</span> Browse
                </button>
              </div>
              {customFile.trim() && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  {(["up", "up-build", "down", "build", "pull"] as const).map((a) => (
                    <ActionBtn
                      key={a}
                      label={a}
                      onClick={() => runCustomFileAction(a)}
                      loading={actionRunning === `custom:${a}`}
                      disabled={!!actionRunning}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* File picker modal */}
            {showFilePicker && (
              <ComposeFilePicker
                sessionId={sessionId}
                currentPath={customFile}
                onSelect={(path) => { setCustomFile(path); setShowFilePicker(false); }}
                onClose={() => setShowFilePicker(false)}
              />
            )}

            {/* Detected projects */}
            {projects.length === 0 && !loading ? (
              <div className="flex flex-col items-center gap-2 py-8 text-[var(--text4)]">
                <span className="text-2xl">🐙</span>
                <p className="text-sm">No compose projects found</p>
                <p className="text-[11px] text-[var(--text5)]">Use the custom file path above</p>
              </div>
            ) : (
              projects.map((proj) => {
                const isOpen = expanded.has(proj.name);
                const statusColor = composeCategoryColor(proj.status);

                return (
                  <div
                    key={proj.name}
                    className="rounded-xl border overflow-hidden"
                    style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
                  >
                    {/* Project header */}
                    <div
                      className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                      onClick={() => toggleExpanded(proj.name)}
                      style={{ borderLeft: `3px solid ${statusColor}` }}
                    >
                      <span className="text-[12px] font-semibold text-[var(--text)] flex-1">
                        {proj.name}
                      </span>
                      <span
                        className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                        style={{ color: statusColor, background: `${statusColor}18`, border: `1px solid ${statusColor}30` }}
                      >
                        {proj.status || "unknown"}
                      </span>
                      <span className="text-[10px] text-[var(--text4)] truncate max-w-[200px]" title={proj.config_files}>
                        {proj.config_files}
                      </span>
                      <span className="text-[var(--text4)] text-[10px]">{isOpen ? "▾" : "▸"}</span>
                    </div>

                    {/* Project actions */}
                    <div
                      className="flex gap-2 px-4 pb-3 flex-wrap border-b"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {(["up", "up-build", "down", "down-volumes", "restart", "build", "pull"] as const).map((a) => (
                        <ActionBtn
                          key={a}
                          label={a.replace("-", " ")}
                          danger={a === "down-volumes"}
                          onClick={() => runProjectAction(proj.name, a)}
                          loading={actionRunning === `${proj.name}::${a}`}
                          disabled={!!actionRunning}
                        />
                      ))}
                    </div>

                    {/* Services list */}
                    {isOpen && (
                      <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                        {proj.services.length === 0 ? (
                          <p className="px-4 py-3 text-[11px] text-[var(--text4)] italic">No services found</p>
                        ) : (
                          proj.services.map((svc) => {
                            const svcName = formatContainerName(svc.name);
                            return (
                              <div
                                key={svc.id || svc.name}
                                className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg2)] transition-colors"
                              >
                                <StateBadge state={svc.state || "unknown"} />
                                <span className="text-[12px] font-mono text-[var(--text)] flex-1 truncate">
                                  {svcName}
                                </span>
                                <span className="text-[11px] text-[var(--text4)] truncate max-w-[140px]">
                                  {svc.image}
                                </span>
                                <div className="flex gap-1">
                                  {(["start", "stop", "restart", "build"] as const).map((a) => (
                                    <ActionBtn
                                      key={a}
                                      label={a}
                                      onClick={() => runProjectAction(proj.name, a, svcName)}
                                      loading={actionRunning === `${proj.name}:${svcName}:${a}`}
                                      disabled={!!actionRunning}
                                    />
                                  ))}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {lastOutput && (
          <OutputDrawer
            title={lastOutput.title}
            output={lastOutput.text}
            onClose={() => setLastOutput(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Logs tab ──────────────────────────────────────────────────────────────────

function LogsTab({
  sessionId,
  initialContainerId,
  containers,
  sudoPassword,
  onPermDenied,
}: {
  sessionId: string;
  initialContainerId: string;
  containers: DockerContainer[];
  sudoPassword: string | null;
  onPermDenied: () => void;
}) {
  const [containerId, setContainerId] = useState(initialContainerId || containers[0]?.id || "");
  const [lines, setLines] = useState(100);
  const [follow, setFollow] = useState(false);
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Update containerId when initialContainerId changes (from Containers tab click)
  useEffect(() => {
    if (initialContainerId && initialContainerId !== containerId) {
      setContainerId(initialContainerId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContainerId]);

  const fetchLogs = useCallback(async () => {
    if (!containerId) return;
    try {
      const text = await invoke<string>("docker_logs_tail", {
        sessionId,
        containerId,
        lines,
        sinceSecs: 0,
        sudoPassword,
      });
      setLogs(text);
      setError(null);
    } catch (e) {
      const msg = String(e);
      if (isPermissionDenied(msg)) { onPermDenied(); setError("sudo required — click 🔐 to enter password"); setFollow(false); }
      else { setError(msg); setFollow(false); }
    }
  }, [sessionId, containerId, lines, sudoPassword, onPermDenied]);

  // Initial fetch when container or lines changes
  useEffect(() => {
    if (!containerId) return;
    setLoading(true);
    fetchLogs().finally(() => setLoading(false));
  }, [containerId, lines, fetchLogs]);

  // Follow mode: poll every 2s
  useEffect(() => {
    if (!follow) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(fetchLogs, 2000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [follow, fetchLogs]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const copyLogs = () => {
    navigator.clipboard.writeText(logs).catch(() => {});
  };

  const containerName = (id: string) => {
    const c = containers.find((c) => c.id === id);
    return c ? formatContainerName(c.names) : id;
  };

  return (
    <div className="absolute inset-0 flex flex-col" style={{ background: "var(--bg)" }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b flex-shrink-0 flex-wrap"
        style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
      >
        {/* Container selector */}
        <select
          value={containerId}
          onChange={(e) => { setContainerId(e.target.value); setFollow(false); }}
          className="bg-[var(--bg3)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-[12px] text-[var(--text)] focus:outline-none focus:border-[#6366f1] font-mono"
        >
          {containers.length === 0 ? (
            <option value="">No containers</option>
          ) : (
            containers.map((c) => (
              <option key={c.id} value={c.id}>
                {formatContainerName(c.names)} ({c.state})
              </option>
            ))
          )}
        </select>

        {/* Lines selector */}
        <select
          value={lines}
          onChange={(e) => setLines(Number(e.target.value))}
          className="bg-[var(--bg3)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-[12px] text-[var(--text)] focus:outline-none focus:border-[#6366f1]"
        >
          <option value={50}>50 lines</option>
          <option value={100}>100 lines</option>
          <option value={500}>500 lines</option>
          <option value={1000}>1 000 lines</option>
        </select>

        {/* Follow toggle */}
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <span onClick={() => setFollow((v) => !v)} className="relative inline-flex items-center">
            <div
              className="w-7 h-3.5 rounded-full transition-colors"
              style={{ background: follow ? "#00c8a8" : "var(--border)" }}
            >
              <div
                className="w-3 h-3 rounded-full bg-white transition-transform mt-0.5"
                style={{ transform: follow ? "translateX(15px)" : "translateX(2px)" }}
              />
            </div>
          </span>
          <span className="text-[11px] text-[var(--text3)]">Follow</span>
          {follow && (
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ background: "#00c8a8" }}
            />
          )}
        </label>

        <div className="flex-1" />

        {loading && <span className="text-[11px] text-[var(--text4)]">Loading…</span>}

        <button
          onClick={() => { setLoading(true); fetchLogs().finally(() => setLoading(false)); }}
          disabled={loading || !containerId}
          className="text-[11px] px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-40"
          style={{ color: "#00c8a8", background: "#00c8a812", border: "1px solid #00c8a830" }}
        >
          ↻ Fetch
        </button>
        <button
          onClick={copyLogs}
          disabled={!logs}
          className="text-[11px] px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-30"
          style={{ color: "var(--text3)", background: "var(--bg3)", border: "1px solid var(--border)" }}
        >
          Copy
        </button>
        <button
          onClick={() => setLogs("")}
          disabled={!logs}
          className="text-[11px] px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-30"
          style={{ color: "var(--text3)", background: "var(--bg3)", border: "1px solid var(--border)" }}
        >
          Clear
        </button>
      </div>

      {/* Container name bar */}
      {containerId && (
        <div
          className="px-4 py-1.5 border-b flex items-center gap-2 flex-shrink-0"
          style={{ background: "var(--bg2)", borderColor: "var(--border)" }}
        >
          <span className="text-[10px] uppercase tracking-widest text-[var(--text4)]">Container</span>
          <span className="text-[11px] font-mono text-[var(--text2)]">{containerName(containerId)}</span>
          {follow && (
            <span className="text-[10px] text-[#00c8a8] ml-auto">● Live · polling 2s</span>
          )}
        </div>
      )}

      {/* Log area */}
      {error ? (
        <div className="flex-1 flex items-center justify-center px-8">
          <div className="text-center">
            <p className="text-[var(--text)] font-semibold mb-1">Failed to fetch logs</p>
            <p className="text-[12px] text-[#6b3333] font-mono break-words max-w-xs">{error}</p>
          </div>
        </div>
      ) : !containerId ? (
        <div className="flex-1 flex items-center justify-center text-[var(--text4)] text-sm">
          Select a container above
        </div>
      ) : logs === "" && !loading ? (
        <div className="flex-1 flex items-center justify-center text-[var(--text4)] text-sm">
          No log output
        </div>
      ) : (
        <div
          ref={logRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 font-mono text-[11px] text-[#c9d1d9] whitespace-pre-wrap leading-relaxed"
          style={{ background: "var(--bg)" }}
        >
          {logs}
        </div>
      )}
    </div>
  );
}

// ── System tab ────────────────────────────────────────────────────────────────

const PRUNE_ACTIONS = [
  { target: "containers",     label: "Stopped containers",     danger: false },
  { target: "images",         label: "Dangling images",        danger: false },
  { target: "images-all",     label: "All unused images",      danger: true  },
  { target: "volumes",        label: "Unused volumes",         danger: true  },
  { target: "networks",       label: "Unused networks",        danger: false },
  { target: "build-cache",    label: "Build cache",            danger: false },
  { target: "system",         label: "System prune (all)",     danger: true  },
  { target: "system-volumes", label: "System + volumes",       danger: true  },
] as const;

function SystemTab({
  sessionId,
  sudoPassword,
  onPermDenied,
}: {
  sessionId: string;
  sudoPassword: string | null;
  onPermDenied: () => void;
}) {
  const [df, setDf] = useState<string | null>(null);
  const [dfLoading, setDfLoading] = useState(false);
  const [dfError, setDfError] = useState<string | null>(null);
  const [pruneRunning, setPruneRunning] = useState<string | null>(null);
  const [pruneOutput, setPruneOutput] = useState<{ title: string; text: string } | null>(null);
  const [confirmPrune, setConfirmPrune] = useState<string | null>(null);

  const fetchDf = useCallback(async () => {
    setDfLoading(true);
    setDfError(null);
    try {
      const out = await invoke<string>("docker_system_df", { sessionId, sudoPassword });
      setDf(out);
    } catch (e) {
      const msg = String(e);
      if (isPermissionDenied(msg)) { onPermDenied(); setDfError("sudo required — click 🔐 to enter password"); }
      else setDfError(msg);
    } finally {
      setDfLoading(false);
    }
  }, [sessionId, sudoPassword, onPermDenied]);

  useEffect(() => { fetchDf(); }, [fetchDf]);

  const runPrune = async (target: string, label: string) => {
    setConfirmPrune(null);
    setPruneRunning(target);
    try {
      const out = await invoke<string>("docker_prune", { sessionId, target, sudoPassword });
      setPruneOutput({ title: `Pruned: ${label}`, text: out });
      await fetchDf();
    } catch (e) {
      const msg = String(e);
      if (isPermissionDenied(msg)) { onPermDenied(); setPruneOutput({ title: "sudo required", text: "Enter sudo password and try again." }); }
      else setPruneOutput({ title: `Prune failed: ${label}`, text: msg });
    } finally {
      setPruneRunning(null);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col overflow-y-auto" style={{ background: "var(--bg)" }}>
      <div className="p-4 space-y-4">
        {/* Disk usage */}
        <div
          className="rounded-xl border overflow-hidden"
          style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
        >
          <div
            className="flex items-center justify-between px-4 py-2.5 border-b"
            style={{ borderColor: "var(--border)" }}
          >
            <span className="text-[12px] font-semibold text-[var(--text)]">Docker disk usage</span>
            <button
              onClick={fetchDf}
              disabled={dfLoading}
              className="text-[11px] px-2.5 py-1 rounded-lg disabled:opacity-40 transition-colors"
              style={{ color: "#00c8a8", background: "#00c8a812", border: "1px solid #00c8a830" }}
            >
              {dfLoading ? "…" : "↻ Refresh"}
            </button>
          </div>
          {dfError ? (
            <p className="px-4 py-3 text-[12px] text-[#6b3333] font-mono">{dfError}</p>
          ) : df ? (
            <pre className="px-4 py-3 font-mono text-[11px] text-[#c9d1d9] overflow-x-auto">
              {df}
            </pre>
          ) : (
            <p className="px-4 py-3 text-[11px] text-[var(--text4)]">Loading…</p>
          )}
        </div>

        {/* Prune section */}
        <div
          className="rounded-xl border overflow-hidden"
          style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
        >
          <div className="px-4 py-2.5 border-b" style={{ borderColor: "var(--border)" }}>
            <span className="text-[12px] font-semibold text-[var(--text)]">Prune resources</span>
            <p className="text-[11px] text-[var(--text4)] mt-0.5">Reclaim disk space by removing unused Docker resources</p>
          </div>
          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
            {PRUNE_ACTIONS.map(({ target, label, danger }) => (
              <div
                key={target}
                className="flex items-center justify-between px-4 py-2.5 hover:bg-[var(--bg2)] transition-colors"
              >
                <span className="text-[12px] text-[var(--text2)]">{label}</span>
                {confirmPrune === target ? (
                  <div className="flex gap-2">
                    <button
                      onClick={() => runPrune(target, label)}
                      className="text-[11px] px-3 py-1 rounded font-semibold transition-colors"
                      style={{ color: "#ef4444", background: "#ef444412", border: "1px solid #ef444430" }}
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmPrune(null)}
                      className="text-[11px] px-3 py-1 rounded transition-colors"
                      style={{ color: "var(--text3)", border: "1px solid var(--border)" }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmPrune(target)}
                    disabled={!!pruneRunning}
                    className="text-[11px] px-3 py-1 rounded font-medium transition-colors disabled:opacity-40"
                    style={
                      danger
                        ? { color: "#f87171", background: "#f8717112", border: "1px solid #f8717130" }
                        : { color: "var(--text3)", background: "var(--bg3)", border: "1px solid var(--border)" }
                    }
                  >
                    {pruneRunning === target ? "Pruning…" : "Prune"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Prune output drawer */}
      {pruneOutput && (
        <OutputDrawer
          title={pruneOutput.title}
          output={pruneOutput.text}
          onClose={() => setPruneOutput(null)}
        />
      )}
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function DockerManager({ sessionId, isActive, onSendToTerminal }: Props) {
  const [activeTab, setActiveTab] = useState<DockerTab>("containers");
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [logTarget, setLogTarget] = useState("");

  // ── Sudo state ──────────────────────────────────────────────────────────────
  const [sudoPassword, setSudoPassword] = useState<string | null>(null);
  const [showSudoModal, setShowSudoModal] = useState(false);

  const handlePermDenied = useCallback(() => {
    setShowSudoModal(true);
  }, []);

  const handleSudoConfirm = useCallback((pw: string) => {
    setSudoPassword(pw);
    setShowSudoModal(false);
  }, []);

  const handleSudoClear = useCallback(() => {
    setSudoPassword(null);
  }, []);

  // Keep a shared container list so Logs tab can populate its selector
  // without a separate fetch. ContainersTab updates this via its own fetches.
  const handleContainersLoaded = useCallback((list: DockerContainer[]) => {
    setContainers(list);
  }, []);

  const handleViewLogs = useCallback((containerId: string) => {
    setLogTarget(containerId);
    setActiveTab("logs");
  }, []);

  const handleSendToTerminal = useCallback(
    (cmd: string) => {
      onSendToTerminal(cmd);
    },
    [onSendToTerminal]
  );

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--text4)]">
        <span className="text-4xl">🐳</span>
        <p className="text-sm font-medium">No active SSH session</p>
        <p className="text-[12px] text-[var(--text5)]">Open a terminal and connect first</p>
      </div>
    );
  }

  const TABS: { id: DockerTab; label: string; icon: string }[] = [
    { id: "containers", label: "Containers", icon: "□" },
    { id: "compose",    label: "Compose",    icon: "🐙" },
    { id: "logs",       label: "Logs",       icon: "📋" },
    { id: "system",     label: "System",     icon: "💾" },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 border-b flex-shrink-0"
        style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
      >
        {/* Docker icon */}
        <div
          className="w-6 h-6 flex items-center justify-center rounded-md flex-shrink-0"
          style={{ background: "#2563eb15", border: "1px solid #2563eb25" }}
        >
          <span className="text-[12px]">🐳</span>
        </div>
        <span className="text-[12px] font-semibold text-[var(--text)]">Docker</span>
        <span className="text-[11px] text-[var(--text4)]">Remote Docker control over SSH</span>

        {/* Sudo indicator */}
        {sudoPassword ? (
          <button
            onClick={handleSudoClear}
            title="sudo active — click to clear password"
            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full transition-colors"
            style={{ color: "#f59e0b", background: "#f59e0b12", border: "1px solid #f59e0b25" }}
          >
            🔐 sudo active ✕
          </button>
        ) : (
          <button
            onClick={() => setShowSudoModal(true)}
            title="Set sudo password for Docker commands"
            className="text-[10px] px-2 py-0.5 rounded-full transition-colors text-[var(--text4)] hover:text-[var(--text3)]"
            style={{ border: "1px solid var(--border)" }}
          >
            🔐 sudo
          </button>
        )}

        <div className="flex-1" />

        {/* Sub-tabs */}
        <div className="flex items-center gap-1 bg-[var(--bg2)] rounded-lg p-0.5 border border-[var(--border)]">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
                activeTab === t.id
                  ? "bg-[var(--border)] text-[var(--text)]"
                  : "text-[var(--text3)] hover:text-[var(--text2)]"
              }`}
            >
              <span className="text-[10px]">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden relative">
        {activeTab === "containers" && (
          <ContainersTabWithSharing
            sessionId={sessionId}
            onSendToTerminal={handleSendToTerminal}
            onViewLogs={handleViewLogs}
            onContainersLoaded={handleContainersLoaded}
            sudoPassword={sudoPassword}
            onPermDenied={handlePermDenied}
          />
        )}
        {activeTab === "compose" && (
          <ComposeTab
            sessionId={sessionId}
            sudoPassword={sudoPassword}
            onPermDenied={handlePermDenied}
          />
        )}
        {activeTab === "logs" && (
          <LogsTab
            sessionId={sessionId}
            initialContainerId={logTarget}
            containers={containers}
            sudoPassword={sudoPassword}
            onPermDenied={handlePermDenied}
          />
        )}
        {activeTab === "system" && (
          <SystemTab
            sessionId={sessionId}
            sudoPassword={sudoPassword}
            onPermDenied={handlePermDenied}
          />
        )}

        {/* Sudo password modal — shown automatically on permission denied or manually via button */}
        {showSudoModal && (
          <SudoModal
            onConfirm={handleSudoConfirm}
            onCancel={() => setShowSudoModal(false)}
          />
        )}
      </div>
    </div>
  );
}

// Thin wrapper around ContainersTabInner to expose the loaded container list upward
function ContainersTabWithSharing({
  sessionId,
  onSendToTerminal,
  onViewLogs,
  onContainersLoaded,
  sudoPassword,
  onPermDenied,
}: {
  sessionId: string;
  onSendToTerminal: (cmd: string) => void;
  onViewLogs: (id: string) => void;
  onContainersLoaded: (list: DockerContainer[]) => void;
  sudoPassword: string | null;
  onPermDenied: () => void;
}) {
  return (
    <ContainersTabInner
      sessionId={sessionId}
      onSendToTerminal={onSendToTerminal}
      onViewLogs={onViewLogs}
      onContainersLoaded={onContainersLoaded}
      sudoPassword={sudoPassword}
      onPermDenied={onPermDenied}
    />
  );
}

// ContainersTabInner extends ContainersTab with the onContainersLoaded callback
function ContainersTabInner({
  sessionId,
  onSendToTerminal,
  onViewLogs,
  onContainersLoaded,
  sudoPassword,
  onPermDenied,
}: {
  sessionId: string;
  onSendToTerminal: (cmd: string) => void;
  onViewLogs: (id: string) => void;
  onContainersLoaded: (list: DockerContainer[]) => void;
  sudoPassword: string | null;
  onPermDenied: () => void;
}) {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<{ title: string; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchContainers = useCallback(async () => {
    try {
      const list = await invoke<DockerContainer[]>("docker_list_containers", {
        sessionId,
        sudoPassword,
      });
      setContainers(list);
      onContainersLoaded(list);
      setError(null);
    } catch (e) {
      const msg = String(e);
      if (isPermissionDenied(msg)) { onPermDenied(); setError("sudo required — click 🔐 to enter password"); }
      else setError(msg);
    }
  }, [sessionId, sudoPassword, onContainersLoaded, onPermDenied]);

  useEffect(() => {
    setLoading(true);
    fetchContainers().finally(() => setLoading(false));
  }, [fetchContainers]);

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(fetchContainers, 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, fetchContainers]);

  const runAction = async (containerId: string, action: string, name: string) => {
    const key = `${containerId}:${action}`;
    setActionRunning(key);
    try {
      const out = await invoke<string>("docker_container_action", {
        sessionId,
        containerId,
        action,
        sudoPassword,
      });
      if (out) setLastOutput({ title: `docker ${action} ${name}`, text: out });
      await fetchContainers();
    } catch (e) {
      const msg = String(e);
      if (isPermissionDenied(msg)) { onPermDenied(); setLastOutput({ title: "sudo required", text: "Enter sudo password and try again." }); }
      else setLastOutput({ title: `docker ${action} ${name} — ERROR`, text: msg });
    } finally {
      setActionRunning(null);
    }
  };

  const filtered = filter.trim()
    ? containers.filter(
        (c) =>
          formatContainerName(c.names).toLowerCase().includes(filter.toLowerCase()) ||
          c.image.toLowerCase().includes(filter.toLowerCase())
      )
    : containers;

  const running = containers.filter((c) => parseContainerState(c.state) === "running").length;

  return (
    <div className="absolute inset-0 flex flex-col" style={{ background: "var(--bg)" }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b flex-shrink-0"
        style={{ background: "var(--bg1)", borderColor: "var(--border)" }}
      >
        <input
          type="text"
          placeholder="Filter by name or image…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 bg-[var(--bg3)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-[12px] text-[var(--text)] placeholder-[var(--text4)] focus:outline-none focus:border-[#6366f1] transition-colors font-mono"
        />
        <span className="text-[11px] text-[var(--text4)] whitespace-nowrap">
          {running}/{containers.length} running
        </span>
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <span onClick={() => setAutoRefresh((v) => !v)} className="relative inline-flex items-center">
            <div
              className="w-7 h-3.5 rounded-full transition-colors"
              style={{ background: autoRefresh ? "#00c8a8" : "var(--border)" }}
            >
              <div
                className="w-3 h-3 rounded-full bg-white transition-transform mt-0.5"
                style={{ transform: autoRefresh ? "translateX(15px)" : "translateX(2px)" }}
              />
            </div>
          </span>
          <span className="text-[11px] text-[var(--text3)]">Auto</span>
        </label>
        <button
          onClick={() => { setLoading(true); fetchContainers().finally(() => setLoading(false)); }}
          disabled={loading}
          className="text-[11px] px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-40"
          style={{ color: "#00c8a8", background: "#00c8a812", border: "1px solid #00c8a830" }}
        >
          {loading ? "…" : "↻ Refresh"}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto relative">
        {error ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-8">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: "#ef444410", border: "1px solid #ef444425" }}
            >
              <span className="text-lg">🐳</span>
            </div>
            <div className="text-center">
              <p className="text-[var(--text)] font-semibold mb-1">Docker unavailable</p>
              <p className="text-[12px] text-[#6b3333] font-mono break-words max-w-xs">{error}</p>
            </div>
          </div>
        ) : filtered.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text4)]">
            <span className="text-3xl">🐳</span>
            <p className="text-sm">
              {filter ? `No containers match "${filter}"` : "No containers found"}
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0" style={{ background: "var(--bg1)" }}>
              <tr className="text-left border-b border-[var(--border)]">
                {["Name", "Image", "Status", "Ports", "Actions"].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2.5 text-[10px] font-semibold tracking-widest uppercase text-[var(--text4)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const name = formatContainerName(c.names);
                const cat = parseContainerState(c.state);
                const isRunning = cat === "running";
                const busy = (a: string) => actionRunning === `${c.id}:${a}`;

                return (
                  <tr
                    key={c.id}
                    className="border-b border-[var(--bg2)] hover:bg-[var(--bg2)] transition-colors"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <StateBadge state={c.state} />
                        <span
                          className="text-[12px] font-mono text-[var(--text)] font-medium truncate max-w-[140px]"
                          title={name}
                        >
                          {name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-[var(--text3)] max-w-[180px]">
                      <span className="truncate block" title={c.image}>{c.image}</span>
                    </td>
                    <td className="px-4 py-2.5 text-[11px] text-[var(--text3)] whitespace-nowrap">
                      {c.status}
                    </td>
                    <td className="px-4 py-2.5 text-[11px] font-mono text-[var(--text4)] max-w-[160px]">
                      <span title={c.ports}>{formatDockerPorts(c.ports)}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1 flex-wrap">
                        {isRunning ? (
                          <>
                            <ActionBtn
                              label="Stop"
                              onClick={() => runAction(c.id, "stop", name)}
                              loading={busy("stop")}
                              disabled={!!actionRunning}
                            />
                            <ActionBtn
                              label="Restart"
                              onClick={() => runAction(c.id, "restart", name)}
                              loading={busy("restart")}
                              disabled={!!actionRunning}
                            />
                            <ActionBtn
                              label="Logs"
                              onClick={() => onViewLogs(c.id)}
                            />
                            <ActionBtn
                              label="Exec"
                              onClick={() => {
                                const pfx = sudoPassword ? "sudo " : "";
                                onSendToTerminal(
                                  `${pfx}docker exec -it ${name} bash || ${pfx}docker exec -it ${name} sh`
                                );
                              }}
                              title={`Open a shell in this container${sudoPassword ? " (via sudo)" : ""}`}
                            />
                          </>
                        ) : (
                          <ActionBtn
                            label="Start"
                            onClick={() => runAction(c.id, "start", name)}
                            loading={busy("start")}
                            disabled={!!actionRunning}
                          />
                        )}
                        {confirmRemove === c.id ? (
                          <>
                            <ActionBtn
                              label="Confirm"
                              onClick={() => {
                                setConfirmRemove(null);
                                runAction(c.id, "remove", name);
                              }}
                              danger
                            />
                            <ActionBtn label="Cancel" onClick={() => setConfirmRemove(null)} />
                          </>
                        ) : (
                          <ActionBtn
                            label="Remove"
                            onClick={() => setConfirmRemove(c.id)}
                            danger
                            disabled={!!actionRunning}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {lastOutput && (
          <OutputDrawer
            title={lastOutput.title}
            output={lastOutput.text}
            onClose={() => setLastOutput(null)}
          />
        )}
      </div>
    </div>
  );
}
