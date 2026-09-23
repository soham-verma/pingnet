import { useEffect, useRef, useState } from "react";
import { HostFolder, HostState } from "../types";
import { PingSession } from "../hooks/usePing";
import { formatLatency } from "../utils/network";
import { groupHosts } from "../utils/hostOrder";

interface Props {
  hosts: HostState[];
  folders: HostFolder[];
  selectedId: string | null;
  sessions: Record<string, PingSession>;
  viewMode: "ping" | "ssh" | "dashboard";
  onSelect: (id: string) => void;
  onOpenPing: (id: string) => void;
  onOpenSSH: (id: string) => void;
  onOpenKeyManager: () => void;
  onOpenLocalTerminal: () => void;
  onOpenSpeedtest: () => void;
  onAddHost: () => void;
  onMoveHost: (hostId: string, folderId: string | null, beforeId: string | null) => void;
  onMoveFolder: (folderId: string, beforeId: string | null) => void;
  onCreateFolder: () => string;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onToggleFolder: (folderId: string) => void;
  localTerminalActive: boolean;
  localSpeedtestActive: boolean;
  currentVersion: string | null;
  updateAvailable: boolean;
  onOpenUpdate: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onGoHome: () => void;
}

const CYAN = "#00c8a8";

// ── Drag & drop types ─────────────────────────────────────────────────────────
// Pointer-event based (not HTML5 DnD) so it behaves the same in WKWebView,
// WebView2 and WebKitGTK and doesn't fight Tauri's native file-drop handler.

type DragItem = { kind: "host" | "folder"; id: string; label: string };

type DropTarget =
  | { kind: "host-line"; folderId: string | null; beforeId: string | null; lineHostId: string; pos: "before" | "after" }
  | { kind: "host-into-folder"; folderId: string }
  | { kind: "host-ungrouped-end" }
  | { kind: "folder-line"; beforeId: string | null; lineFolderId: string | null; pos: "before" | "after" | "end" };

const DRAG_THRESHOLD_PX = 5;

function statusColorFor(session: PingSession | undefined): string {
  const lastResult = session?.lastResult;
  if (session?.isRunning) return "#f59e0b";
  if (!lastResult) return "var(--text4)";
  return lastResult.success ? "#22c55e" : "#ef4444";
}

function MiniBar({ history }: { history: { latency: number | null; success: boolean }[] }) {
  const last12 = history.slice(-12);
  const maxLat = Math.max(...last12.map((h) => h.latency ?? 0), 1);

  return (
    <div className="flex items-end gap-[2px] h-4">
      {last12.map((h, i) => {
        const height = h.success && h.latency ? Math.max(3, (h.latency / maxLat) * 16) : 3;
        return (
          <div
            key={i}
            className="w-[3px] rounded-sm"
            style={{
              height: `${height}px`,
              backgroundColor: h.success ? CYAN : "#ef4444",
              opacity: 0.7 + (i / last12.length) * 0.3,
            }}
          />
        );
      })}
    </div>
  );
}

function PlusIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  );
}

function DropLine({ edge }: { edge: "top" | "bottom" }) {
  return (
    <div
      className="absolute left-1 right-1 h-[2px] rounded-full pointer-events-none z-10"
      style={{ [edge]: -3, background: CYAN, boxShadow: `0 0 6px ${CYAN}` }}
    />
  );
}

export default function Sidebar({
  hosts, folders, selectedId, sessions, viewMode, onSelect, onOpenPing, onOpenSSH, onOpenKeyManager,
  onOpenLocalTerminal, onOpenSpeedtest, onAddHost, onMoveHost, onMoveFolder, onCreateFolder,
  onRenameFolder, onDeleteFolder, onToggleFolder, localTerminalActive, localSpeedtestActive,
  currentVersion, updateAvailable, onOpenUpdate, collapsed, onToggleCollapse, onGoHome,
}: Props) {
  const groups = groupHosts(hosts, folders);

  // ── Folder rename state ─────────────────────────────────────────────────────
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState("");

  function startRename(f: HostFolder) {
    setEditingFolderId(f.id);
    setFolderDraft(f.name);
  }
  function commitRename() {
    if (editingFolderId) {
      const name = folderDraft.trim();
      if (name) onRenameFolder(editingFolderId, name);
    }
    setEditingFolderId(null);
  }
  function handleNewFolder() {
    const id = onCreateFolder();
    setEditingFolderId(id);
    setFolderDraft("New folder");
  }

  // ── Drag & drop ─────────────────────────────────────────────────────────────
  const listRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<{ item: DragItem; x: number; y: number } | null>(null);
  const dragRef = useRef<DragItem | null>(null);
  const targetRef = useRef<DropTarget | null>(null);
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<{ item: DragItem; x: number; y: number } | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  // Latest data/callbacks for the window-level listeners registered once below
  const liveRef = useRef({ groups, folders, onMoveHost, onMoveFolder });
  liveRef.current = { groups, folders, onMoveHost, onMoveFolder };

  function startPress(e: React.PointerEvent, item: DragItem) {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, [data-nodrag]")) return;
    pendingRef.current = { item, x: e.clientX, y: e.clientY };
  }

  /** Swallow the click that follows a drop so it doesn't also select/toggle. */
  function guardClick(fn: () => void) {
    return () => {
      if (suppressClickRef.current) return;
      fn();
    };
  }

  useEffect(() => {
    function hitTest(x: number, y: number, item: DragItem): DropTarget | null {
      const list = listRef.current;
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!list || !el || !list.contains(el)) return null;
      const { groups, folders } = liveRef.current;

      if (item.kind === "host") {
        const hostEl = el.closest<HTMLElement>("[data-dnd-host]");
        if (hostEl) {
          const id = hostEl.dataset.dndHost!;
          if (id === item.id) return null;
          const r = hostEl.getBoundingClientRect();
          const pos = y < r.top + r.height / 2 ? "before" : "after";
          const group = groups.find((g) => g.hosts.some((h) => h.id === id));
          if (!group) return null;
          const idx = group.hosts.findIndex((h) => h.id === id);
          const beforeId = pos === "before" ? id : group.hosts[idx + 1]?.id ?? null;
          return { kind: "host-line", folderId: group.folder?.id ?? null, beforeId, lineHostId: id, pos };
        }
        const folderEl = el.closest<HTMLElement>("[data-dnd-folder]");
        if (folderEl) return { kind: "host-into-folder", folderId: folderEl.dataset.dndFolder! };
        return { kind: "host-ungrouped-end" };
      }

      // Folder being dragged — only reorders among folders (no nesting)
      const folderEl = el.closest<HTMLElement>("[data-dnd-folder]");
      if (folderEl) {
        const id = folderEl.dataset.dndFolder!;
        if (id === item.id) return null;
        const r = folderEl.getBoundingClientRect();
        const pos = y < r.top + r.height / 2 ? "before" : "after";
        const idx = folders.findIndex((f) => f.id === id);
        const beforeId = pos === "before" ? id : folders[idx + 1]?.id ?? null;
        return { kind: "folder-line", beforeId, lineFolderId: id, pos };
      }
      return { kind: "folder-line", beforeId: null, lineFolderId: null, pos: "end" };
    }

    function reset() {
      pendingRef.current = null;
      dragRef.current = null;
      targetRef.current = null;
      setDrag(null);
      setTarget(null);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }

    function onMove(e: PointerEvent) {
      const p = pendingRef.current;
      if (!p) return;
      if (!dragRef.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
        dragRef.current = p.item;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        window.getSelection()?.removeAllRanges();
      }
      setDrag({ item: p.item, x: e.clientX, y: e.clientY });
      const t = hitTest(e.clientX, e.clientY, p.item);
      targetRef.current = t;
      setTarget(t);

      // Auto-scroll the list when dragging near its top/bottom edge
      const list = listRef.current;
      if (list) {
        const r = list.getBoundingClientRect();
        if (e.clientY < r.top + 28) list.scrollTop -= 10;
        else if (e.clientY > r.bottom - 28) list.scrollTop += 10;
      }
    }

    function onUp() {
      const item = dragRef.current;
      const t = targetRef.current;
      if (item) {
        suppressClickRef.current = true;
        setTimeout(() => { suppressClickRef.current = false; }, 0);
        if (t) {
          const { onMoveHost, onMoveFolder } = liveRef.current;
          if (item.kind === "host") {
            if (t.kind === "host-line") onMoveHost(item.id, t.folderId, t.beforeId);
            else if (t.kind === "host-into-folder") onMoveHost(item.id, t.folderId, null);
            else if (t.kind === "host-ungrouped-end") onMoveHost(item.id, null, null);
          } else if (t.kind === "folder-line") {
            onMoveFolder(item.id, t.beforeId);
          }
        }
      }
      reset();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dragRef.current) {
        e.stopPropagation();
        reset();
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", reset);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", reset);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const draggingHost = drag?.item.kind === "host";

  // ── Collapsed rail ──────────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside className="flex-shrink-0 flex flex-col h-full border-r border-[var(--border)] items-center py-4 gap-3" style={{ width: 44, background: "var(--bg1)" }}>
        <button
          onClick={onToggleCollapse}
          title="Expand sidebar"
          className="w-7 h-7 flex items-center justify-center rounded text-[var(--text3)] hover:text-[var(--text2)] hover:bg-[var(--bg3)] transition-all"
        >
          <svg width="13" height="11" viewBox="0 0 13 11" fill="none">
            <rect y="0" width="13" height="1.5" rx="0.75" fill="currentColor"/>
            <rect y="4.5" width="13" height="1.5" rx="0.75" fill="currentColor"/>
            <rect y="9" width="13" height="1.5" rx="0.75" fill="currentColor"/>
          </svg>
        </button>
        {/* Status dots, in sidebar order, with a hairline between folders */}
        <div className="flex flex-col items-center gap-2 flex-1 overflow-hidden pt-1">
          {groups.filter((g) => g.hosts.length > 0).map((g, gi) => (
            <div key={g.folder?.id ?? "ungrouped"} className="flex flex-col items-center gap-2">
              {gi > 0 && <div className="w-4 h-px bg-[var(--border2)]" />}
              {g.hosts.map((host) => {
                const statusColor = statusColorFor(sessions[host.id]);
                const isSelected = host.id === selectedId;
                return (
                  <button
                    key={host.id}
                    onClick={() => onSelect(host.id)}
                    title={g.folder ? `${g.folder.name} / ${host.hostname}` : host.hostname}
                    className="w-7 h-7 flex items-center justify-center rounded transition-all"
                    style={isSelected ? { background: "var(--bg-sel)", border: "1px solid var(--border2)" } : {}}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor, boxShadow: `0 0 5px ${statusColor}80` }} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {/* Local terminal */}
        <button
          onClick={onOpenLocalTerminal}
          title="Local Terminal"
          className="w-7 h-7 flex items-center justify-center rounded transition-all"
          style={localTerminalActive ? { color: CYAN, background: "#00c8a815" } : { color: "var(--text4)" }}
        >
          <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
            <rect x="0.5" y="1.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1"/>
            <path d="M2 5.5L4 4L2 2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M5 5.5H8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
        </button>
        {/* Speed test (this device) */}
        <button
          onClick={onOpenSpeedtest}
          title="Speed Test"
          className="w-7 h-7 flex items-center justify-center rounded transition-all"
          style={localSpeedtestActive ? { color: CYAN, background: "#00c8a815" } : { color: "var(--text4)" }}
        >
          <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
            <path d="M2 9a4 4 0 0 1 8 0" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
            <path d="M6 9L8 5.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
            <circle cx="6" cy="9" r="0.9" fill="currentColor"/>
          </svg>
        </button>
        {/* SSH keys */}
        <button
          onClick={onOpenKeyManager}
          title="SSH Keys"
          className="w-7 h-7 flex items-center justify-center rounded transition-all text-[var(--text4)] hover:text-[#818cf8]"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <circle cx="5" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.1"/>
            <path d="M7 6h5.5M10.5 4.5V7.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
          </svg>
        </button>
        {/* Add device — round primary button */}
        <button
          onClick={onAddHost}
          title="Add device (N)"
          className="w-7 h-7 flex items-center justify-center rounded-full transition-all text-black bg-[#00c8a8] hover:bg-[#1adbbb] hover:scale-105 active:scale-95 shadow-[0_0_10px_#00c8a840] hover:shadow-[0_0_16px_#00c8a880]"
        >
          <PlusIcon size={12} />
        </button>
      </aside>
    );
  }

  // ── Host row ────────────────────────────────────────────────────────────────
  function renderHost(host: HostState) {
    const session = sessions[host.id];
    const isSelected = host.id === selectedId;
    const lastResult = session?.lastResult;
    const isRunning = session?.isRunning ?? false;
    const lastHistory = session?.history ?? [];
    const statusColor = statusColorFor(session);
    const isSSHActive = isSelected && viewMode === "ssh";
    const isDragged = drag?.item.kind === "host" && drag.item.id === host.id;
    const line = target?.kind === "host-line" && target.lineHostId === host.id ? target.pos : null;

    return (
      <div
        key={host.id}
        data-dnd-host={host.id}
        onPointerDown={(e) => startPress(e, { kind: "host", id: host.id, label: host.hostname })}
        className={`relative rounded-lg mb-1 transition-colors select-none ${
          isSelected
            ? "bg-[var(--bg-sel)] border border-[var(--border2)]"
            : "hover:bg-[var(--bg3)] border border-transparent"
        }`}
        style={{ opacity: isDragged ? 0.35 : 1 }}
      >
        {line === "before" && <DropLine edge="top" />}
        {line === "after" && <DropLine edge="bottom" />}

        {/* Host row */}
        <button
          onClick={guardClick(() => onSelect(host.id))}
          className="w-full text-left px-3 pt-3 pb-2"
        >
          <div className="flex items-center justify-between mb-1">
            <span className={`text-sm font-medium truncate ${isSelected ? "text-[var(--text)]" : "text-[var(--text2)]"}`}>
              {host.hostname}
            </span>
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ml-2 ${isRunning ? "ping-pulsing" : ""}`}
              style={{ backgroundColor: statusColor, boxShadow: `0 0 6px ${statusColor}80` }}
            />
          </div>
          <div className="font-mono text-[11px] text-[var(--text3)] mb-2">{host.ip}</div>
          {lastHistory.length > 0 ? (
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[var(--text4)]">
                {lastResult?.success ? formatLatency(lastResult.latency_ms ?? 0) : "FAIL"}
              </span>
              <MiniBar history={lastHistory} />
            </div>
          ) : (
            <div className="text-[11px] text-[var(--text5)]">not pinged</div>
          )}
        </button>

        {/* Ping / SSH switch (shown when host is selected) */}
        {isSelected && (
          <div className="px-3 pb-2.5 flex gap-1">
            <button
              data-nodrag
              onClick={guardClick(() => onOpenPing(host.id))}
              className={`flex-1 flex items-center justify-center gap-1 py-1 rounded-md text-[10px] font-medium transition-all ${
                viewMode === "ping"
                  ? "bg-[#00c8a818] text-[#00c8a8] border border-[#00c8a820]"
                  : "text-[var(--text4)] hover:text-[var(--text3)] hover:bg-[var(--border)]"
              }`}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <circle cx="4" cy="4" r="1.5" fill="currentColor" />
                <circle cx="4" cy="4" r="3.5" stroke="currentColor" strokeWidth="0.8" strokeOpacity="0.5" />
              </svg>
              Ping
            </button>
            <button
              data-nodrag
              onClick={guardClick(() => onOpenSSH(host.id))}
              className={`flex-1 flex items-center justify-center gap-1 py-1 rounded-md text-[10px] font-medium transition-all ${
                isSSHActive
                  ? "bg-[#6366f118] text-[#818cf8] border border-[#6366f120]"
                  : "text-[var(--text4)] hover:text-[var(--text3)] hover:bg-[var(--border)]"
              }`}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <rect x="0.5" y="1.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="0.8" />
                <path d="M2 4l1 -1 -1 -1" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 4.5h2" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
              </svg>
              SSH
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Folder block ────────────────────────────────────────────────────────────
  function renderFolder(folder: HostFolder, folderHosts: HostState[]) {
    const isEditing = editingFolderId === folder.id;
    const isDragged = drag?.item.kind === "folder" && drag.item.id === folder.id;
    const isDropInto = target?.kind === "host-into-folder" && target.folderId === folder.id;
    const line = target?.kind === "folder-line" && target.lineFolderId === folder.id ? target.pos : null;
    const downCount = folderHosts.filter((h) => sessions[h.id]?.lastResult?.success === false).length;
    const hasSelected = folderHosts.some((h) => h.id === selectedId);

    return (
      <div
        key={folder.id}
        data-dnd-folder={folder.id}
        className="relative mb-1 rounded-lg transition-colors"
        style={{
          opacity: isDragged ? 0.35 : 1,
          outline: isDropInto ? `1px dashed ${CYAN}` : "none",
          outlineOffset: -1,
          background: isDropInto ? "#00c8a80d" : undefined,
        }}
      >
        {line === "before" && <DropLine edge="top" />}
        {line === "after" && <DropLine edge="bottom" />}

        {/* Header — click toggles, drag reorders, double-click renames */}
        <div
          onPointerDown={(e) => startPress(e, { kind: "folder", id: folder.id, label: folder.name })}
          onClick={(e) => {
            // detail > 1 = second click of a double-click (rename) — don't toggle twice
            if (e.detail > 1 || isEditing || suppressClickRef.current) return;
            onToggleFolder(folder.id);
          }}
          onDoubleClick={() => startRename(folder)}
          className="group flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-[var(--bg3)] select-none cursor-default"
          title={folder.collapsed ? "Expand folder" : "Collapse folder"}
        >
          <svg
            width="8" height="8" viewBox="0 0 8 8" fill="none"
            className="flex-shrink-0 text-[var(--text4)] transition-transform"
            style={{ transform: folder.collapsed ? "rotate(-90deg)" : "none" }}
          >
            <path d="M1.5 2.75L4 5.25L6.5 2.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="flex-shrink-0" style={{ color: CYAN, opacity: 0.8 }}>
            <path d="M1 3.2c0-.66.54-1.2 1.2-1.2h2.3l1.1 1.2h4.2c.66 0 1.2.54 1.2 1.2v4.4c0 .66-.54 1.2-1.2 1.2H2.2C1.54 10 1 9.46 1 8.8V3.2z"
              stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
          </svg>

          {isEditing ? (
            <input
              autoFocus
              value={folderDraft}
              onChange={(e) => setFolderDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingFolderId(null);
              }}
              maxLength={40}
              className="flex-1 min-w-0 bg-[var(--bg)] border border-[#00c8a860] rounded px-1.5 py-0.5 text-[11px] text-[var(--text)] outline-none"
            />
          ) : (
            <span className={`flex-1 min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider ${hasSelected && folder.collapsed ? "text-[var(--text2)]" : "text-[var(--text3)]"}`}>
              {folder.name}
            </span>
          )}

          {!isEditing && (
            <>
              {downCount > 0 && (
                <span className="flex items-center gap-1 text-[10px] text-[#ef4444] group-hover:hidden" title={`${downCount} down`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444]" />{downCount}
                </span>
              )}
              <span className="text-[10px] font-mono text-[var(--text5)] group-hover:hidden">{folderHosts.length}</span>
              <div className="hidden group-hover:flex items-center gap-0.5">
                <button
                  data-nodrag
                  title="Rename folder"
                  onClick={(e) => { e.stopPropagation(); startRename(folder); }}
                  className="w-5 h-5 flex items-center justify-center rounded text-[var(--text4)] hover:text-[var(--text2)] hover:bg-[var(--border)]"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M6.5 1.5l2 2L3.5 8.5H1.5v-2l5-5z" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round"/>
                  </svg>
                </button>
                <button
                  data-nodrag
                  title="Delete folder (devices move to Ungrouped)"
                  onClick={(e) => { e.stopPropagation(); onDeleteFolder(folder.id); }}
                  className="w-5 h-5 flex items-center justify-center rounded text-[var(--text4)] hover:text-[#ef4444] hover:bg-[var(--border)]"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Children */}
        {!folder.collapsed && (
          <div className="ml-2.5 pl-1.5 border-l border-[var(--border)] mt-0.5">
            {folderHosts.map(renderHost)}
            {folderHosts.length === 0 && (
              <div className="px-2 py-2 text-[10px] text-[var(--text5)]">
                Drag devices here
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const ungrouped = groups[groups.length - 1].hosts;
  const showUngroupedLabel = folders.length > 0 && (ungrouped.length > 0 || draggingHost);

  // ── Expanded ────────────────────────────────────────────────────────────────
  return (
    <aside className="w-56 flex-shrink-0 flex flex-col h-full border-r border-[var(--border)]" style={{ background: "var(--bg1)" }}>
      {/* Header */}
      <div className="px-4 pt-6 pb-4 flex items-center justify-between">
        <button
          onClick={onGoHome}
          title="Dashboard"
          className="flex items-center gap-2 rounded transition-opacity hover:opacity-80"
        >
          <svg width="16" height="16" viewBox="0 0 200 200" fill="none">
            <path d="M 80,148 L 80,64 C 80,44 96,36 112,36 C 138,36 148,60 148,86 C 148,110 132,124 110,124 L 90,124"
              stroke={CYAN} strokeWidth="13" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="80" cy="148" r="10" fill={CYAN}/>
          </svg>
          <span className="text-[11px] font-semibold tracking-[0.2em] text-[var(--text2)] uppercase">
            Pingboard
          </span>
        </button>
        <button
          onClick={onToggleCollapse}
          title="Collapse sidebar"
          className="w-6 h-6 flex items-center justify-center rounded text-[var(--text5)] hover:text-[var(--text3)] hover:bg-[var(--bg3)] transition-all"
        >
          <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
            <path d="M9 1L5 5L1 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 5L5 9L1 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" opacity="0.4"/>
          </svg>
        </button>
      </div>

      {/* Section header — device count + new folder */}
      <div className="px-4 pb-1.5 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.15em] uppercase text-[var(--text4)]">
          Devices{hosts.length > 0 ? ` · ${hosts.length}` : ""}
        </span>
        <button
          onClick={handleNewFolder}
          title="New folder"
          className="w-5 h-5 flex items-center justify-center rounded text-[var(--text4)] hover:text-[#00c8a8] hover:bg-[var(--bg3)] transition-all"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 3.2c0-.66.54-1.2 1.2-1.2h2.3l1.1 1.2h4.2c.66 0 1.2.54 1.2 1.2v4.4c0 .66-.54 1.2-1.2 1.2H2.2C1.54 10 1 9.46 1 8.8V3.2z"
              stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
            <path d="M6 5v3M4.5 6.5h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* Host list — folders first, then ungrouped */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-4">
        {hosts.length === 0 && folders.length === 0 && (
          <div className="px-3 py-6 text-center text-[var(--text3)] text-xs">
            No hosts yet.<br />Add one below.
          </div>
        )}

        {groups.slice(0, -1).map((g) => renderFolder(g.folder!, g.hosts))}

        {/* Drop line for "move folder to end" */}
        {target?.kind === "folder-line" && target.pos === "end" && (
          <div className="relative h-1 mb-1"><DropLine edge="top" /></div>
        )}

        {showUngroupedLabel && (
          <div className="px-2 pt-2 pb-1 text-[10px] tracking-[0.15em] uppercase text-[var(--text5)]">
            Ungrouped
          </div>
        )}
        {ungrouped.map(renderHost)}

        {/* Drop zone for pulling a device out of every folder */}
        {draggingHost && folders.length > 0 && ungrouped.length === 0 && (
          <div
            className="mx-1 mb-1 rounded-lg px-3 py-3 text-center text-[10px] text-[var(--text4)]"
            style={{
              border: `1px dashed ${target?.kind === "host-ungrouped-end" ? CYAN : "var(--border2)"}`,
              color: target?.kind === "host-ungrouped-end" ? CYAN : undefined,
            }}
          >
            Drop here to ungroup
          </div>
        )}
        {target?.kind === "host-ungrouped-end" && ungrouped.length > 0 && (
          <div className="relative h-1"><DropLine edge="top" /></div>
        )}
      </div>

      {/* Bottom toolbar — compact icon row + version */}
      <div className="border-t border-[var(--border)]" style={{ background: "var(--bg1)" }}>

        {/* Icon row */}
        <div className="flex items-center px-2 py-2 gap-0.5">

          {/* Local terminal */}
          <button
            onClick={onOpenLocalTerminal}
            title="Local Terminal"
            className="flex-1 flex items-center justify-center py-2.5 rounded-lg transition-all"
            style={localTerminalActive
              ? { color: CYAN, background: "#00c8a812" }
              : { color: "var(--text4)" }}
            onMouseEnter={e => { if (!localTerminalActive) (e.currentTarget as HTMLElement).style.color = CYAN; }}
            onMouseLeave={e => { if (!localTerminalActive) (e.currentTarget as HTMLElement).style.color = "var(--text4)"; }}
          >
            <svg width="15" height="15" viewBox="0 0 12 12" fill="none">
              <rect x="0.5" y="1.5" width="11" height="9" rx="1.5" stroke="currentColor" strokeWidth="1"/>
              <path d="M2 5.5L4 4L2 2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M5 5.5H8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
            </svg>
          </button>

          {/* Speed test (this device) */}
          <button
            onClick={onOpenSpeedtest}
            title="Speed Test"
            className="flex-1 flex items-center justify-center py-2.5 rounded-lg transition-all"
            style={localSpeedtestActive
              ? { color: CYAN, background: "#00c8a812" }
              : { color: "var(--text4)" }}
            onMouseEnter={e => { if (!localSpeedtestActive) (e.currentTarget as HTMLElement).style.color = CYAN; }}
            onMouseLeave={e => { if (!localSpeedtestActive) (e.currentTarget as HTMLElement).style.color = "var(--text4)"; }}
          >
            <svg width="15" height="15" viewBox="0 0 12 12" fill="none">
              <path d="M2 9a4 4 0 0 1 8 0" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              <path d="M6 9L8 5.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              <circle cx="6" cy="9" r="0.9" fill="currentColor"/>
            </svg>
          </button>

          {/* SSH keys */}
          <button
            onClick={onOpenKeyManager}
            title="SSH Keys"
            className="flex-1 flex items-center justify-center py-2.5 rounded-lg text-[var(--text4)] hover:text-[#818cf8] transition-all"
          >
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
              <circle cx="5" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.1"/>
              <path d="M7 6h5.5M10.5 4.5V7.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
            </svg>
          </button>

          {/* Add device — round primary button */}
          <div className="flex-1 flex items-center justify-center">
            <button
              onClick={onAddHost}
              title="Add device (N)"
              className="w-8 h-8 flex items-center justify-center rounded-full transition-all text-black bg-[#00c8a8] hover:bg-[#1adbbb] hover:scale-105 active:scale-95 shadow-[0_0_12px_#00c8a840] hover:shadow-[0_0_18px_#00c8a880]"
            >
              <PlusIcon size={14} />
            </button>
          </div>
        </div>

        {/* Version / update */}
        <button
          onClick={onOpenUpdate}
          className="w-full flex items-center justify-between px-4 pb-3 transition-all group"
        >
          <span className="text-[10px] font-mono text-[var(--text5)] group-hover:text-[var(--text3)] transition-colors">
            v{currentVersion ?? "…"}
          </span>
          {updateAvailable && (
            <span className="flex items-center gap-1 text-[10px] text-[#00c8a8]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00c8a8]" style={{ boxShadow: "0 0 4px #00c8a8" }} />
              update
            </span>
          )}
        </button>
      </div>

      {/* Drag ghost — follows the pointer; pointer-events off so hit-testing sees what's underneath */}
      {drag && (
        <div
          className="fixed z-50 pointer-events-none flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium text-[var(--text)]"
          style={{
            left: drag.x + 12,
            top: drag.y + 8,
            background: "var(--bg-sel)",
            border: `1px solid ${CYAN}60`,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
        >
          {drag.item.kind === "folder" ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ color: CYAN }}>
              <path d="M1 3.2c0-.66.54-1.2 1.2-1.2h2.3l1.1 1.2h4.2c.66 0 1.2.54 1.2 1.2v4.4c0 .66-.54 1.2-1.2 1.2H2.2C1.54 10 1 9.46 1 8.8V3.2z"
                stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
            </svg>
          ) : (
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColorFor(sessions[drag.item.id]) }} />
          )}
          {drag.item.label}
        </div>
      )}
    </aside>
  );
}
