import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileEntry } from "../../types";

interface Props {
  sessionId: string;
  onUploadStart: (id: string, name: string, totalBytes: number) => void;
  onDownloadStart: (id: string, name: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatDate(unixSecs: number): string {
  if (!unixSecs) return "—";
  return new Date(unixSecs * 1000).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.is_dir) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 5H12.5C13.33 5 14 5.67 14 6.5V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"
          fill="#6366f1" fillOpacity="0.3" stroke="#6366f1" strokeWidth="1" />
      </svg>
    );
  }
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const codeExts = ["js","ts","tsx","jsx","py","rs","go","rb","php","c","cpp","h","css","html","json","yaml","yml","toml","sh","bash","zsh"];
  const imgExts = ["png","jpg","jpeg","gif","svg","webp","ico"];
  const archiveExts = ["zip","tar","gz","bz2","xz","7z","rar"];
  const color = entry.is_symlink
    ? "#00c8a8"
    : codeExts.includes(ext)
    ? "#22c55e"
    : imgExts.includes(ext)
    ? "#f59e0b"
    : archiveExts.includes(ext)
    ? "#ef4444"
    : "#4b5563";

  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 2.5C3 2.22 3.22 2 3.5 2H9L13 6V13.5C13 13.78 12.78 14 12.5 14H3.5C3.22 14 3 13.78 3 13.5V2.5Z"
        fill={color} fillOpacity="0.15" stroke={color} strokeWidth="1" />
      <path d="M9 2V6H13" stroke={color} strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

export default function SFTPBrowser({ sessionId, onUploadStart, onDownloadStart }: Props) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async (p: string) => {
    setLoading(true);
    setError(null);
    setSelected(null);
    try {
      const result = await invoke<FileEntry[]>("sftp_list", { sessionId, path: p });
      setEntries(result);
      setPath(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load("/");
  }, [sessionId]);

  const navigate = (entry: FileEntry) => {
    if (entry.is_dir) {
      load(entry.path);
    }
  };

  const goUp = () => {
    const parts = path.replace(/\/$/, "").split("/").filter(Boolean);
    if (parts.length === 0) return;
    parts.pop();
    load("/" + parts.join("/") || "/");
  };

  const handleDownload = async (entry: FileEntry) => {
    const id = crypto.randomUUID();
    onDownloadStart(id, entry.name);
    try {
      await invoke("sftp_download", {
        sessionId,
        remotePath: entry.path,
        transferId: id,
      });
    } catch (e) {
      console.error("Download failed:", e);
    }
    setContextMenu(null);
  };

  const handleDelete = async (entry: FileEntry) => {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    setContextMenu(null);
    try {
      await invoke("sftp_delete", {
        sessionId,
        path: entry.path,
        isDir: entry.is_dir,
      });
      load(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const startRename = (entry: FileEntry) => {
    setRenaming(entry.path);
    setRenameVal(entry.name);
    setContextMenu(null);
  };

  const commitRename = async () => {
    if (!renaming || !renameVal.trim()) {
      setRenaming(null);
      return;
    }
    const dir = path.replace(/\/$/, "");
    const newPath = `${dir}/${renameVal.trim()}`;
    try {
      await invoke("sftp_rename", { sessionId, oldPath: renaming, newPath });
      setRenaming(null);
      load(path);
    } catch (e) {
      setError(String(e));
      setRenaming(null);
    }
  };

  const handleMkdir = async () => {
    if (!newFolderName.trim()) return;
    const newPath = `${path.replace(/\/$/, "")}/${newFolderName.trim()}`;
    try {
      await invoke("sftp_mkdir", { sessionId, path: newPath });
      setCreating(false);
      setNewFolderName("");
      load(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const id = crypto.randomUUID();
    const remotePath = `${path.replace(/\/$/, "")}/${file.name}`;
    onUploadStart(id, file.name, file.size);
    // Read file as ArrayBuffer and write to a temp path the Rust backend can access
    // We need the actual file path — use the webkitRelativePath or name
    // In Tauri webview, we can read files via the file object
    // But sftp_upload expects a local file path on the host OS
    // We'll use a workaround: write to a temp file first
    try {
      const arrayBuf = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      // Write to temp location via Tauri FS
      const tempPath = `/tmp/pingnet_upload_${file.name}`;
      // Use Tauri's writeBinaryFile equivalent via a custom command
      await invoke("sftp_upload_bytes", {
        sessionId,
        bytes: Array.from(bytes),
        remotePath,
        transferId: id,
        localName: file.name,
      });
    } catch (err) {
      console.error("Upload failed:", err);
    }
    // Reset input
    e.target.value = "";
    setTimeout(() => load(path), 500);
  };

  const breadcrumbs = ["~", ...path.replace(/^\//, "").split("/").filter(Boolean)];

  return (
    <div className="flex flex-col h-full" onClick={() => setContextMenu(null)}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e35] flex-shrink-0" style={{ background: "#0a0a14" }}>
        <button
          onClick={goUp}
          disabled={path === "/" || loading}
          className="w-7 h-7 flex items-center justify-center rounded text-[#4b5563] hover:text-white hover:bg-[#1e1e35] disabled:opacity-30 transition-all"
          title="Parent directory"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          onClick={() => load(path)}
          disabled={loading}
          className="w-7 h-7 flex items-center justify-center rounded text-[#4b5563] hover:text-white hover:bg-[#1e1e35] disabled:opacity-30 transition-all"
          title="Refresh"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={loading ? "animate-spin" : ""}>
            <path d="M11 6A5 5 0 1 1 6 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M11 1v5H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 flex-1 overflow-hidden">
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            const targetPath =
              i === 0
                ? "/"
                : "/" + breadcrumbs.slice(1, i + 1).join("/");
            return (
              <span key={i} className="flex items-center gap-1 min-w-0">
                {i > 0 && <span className="text-[#2d3748] text-[10px]">/</span>}
                <button
                  onClick={() => !isLast && load(targetPath)}
                  className={`text-[12px] truncate transition-colors ${
                    isLast
                      ? "text-[#8892a4] font-medium cursor-default"
                      : "text-[#4b5563] hover:text-[#00c8a8]"
                  }`}
                >
                  {crumb}
                </button>
              </span>
            );
          })}
        </div>

        {/* Actions */}
        <button
          onClick={() => setCreating(true)}
          className="w-7 h-7 flex items-center justify-center rounded text-[#4b5563] hover:text-[#6366f1] hover:bg-[#1e1e35] transition-all"
          title="New folder"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 3.5C1 2.67 1.67 2 2.5 2H5L6 3.5H9.5C10.33 3.5 11 4.17 11 5V8.5C11 9.33 10.33 10 9.5 10H2.5C1.67 10 1 9.33 1 8.5V3.5Z"
              stroke="currentColor" strokeWidth="1.2" />
            <path d="M6 5.5V7.5M5 6.5H7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-7 h-7 flex items-center justify-center rounded text-[#4b5563] hover:text-[#00c8a8] hover:bg-[#1e1e35] transition-all"
          title="Upload file"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 8V2M6 2L3.5 4.5M6 2L8.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M1 9.5V10C1 10.55 1.45 11 2 11H10C10.55 11 11 10.55 11 10V9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInputChange} />
      </div>

      {/* New folder input */}
      {creating && (
        <div className="px-4 py-2 border-b border-[#1e1e35] flex items-center gap-2" style={{ background: "#0a0a14" }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 5H12.5C13.33 5 14 5.67 14 6.5V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"
              fill="#6366f130" stroke="#6366f1" strokeWidth="1" />
          </svg>
          <input
            autoFocus
            className="flex-1 bg-transparent border-b border-[#6366f1] text-white text-sm outline-none py-0.5 font-mono"
            placeholder="folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleMkdir();
              if (e.key === "Escape") { setCreating(false); setNewFolderName(""); }
            }}
          />
          <button onClick={() => { setCreating(false); setNewFolderName(""); }} className="text-[#4b5563] text-xs">Cancel</button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-4 mt-3 p-3 rounded-lg border border-[#ef444430] text-[#ef4444] text-[12px]" style={{ background: "#140808" }}>
          {error}
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-[#374151] text-sm">
            <span className="animate-spin w-4 h-4 border-2 border-[#6366f1] border-t-transparent rounded-full mr-2" />
            Loading...
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-[#2d3748] text-sm">
            Empty directory
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0" style={{ background: "#0a0a14" }}>
              <tr className="text-[10px] tracking-widest text-[#2d3748] uppercase">
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-right px-4 py-2 font-medium hidden sm:table-cell">Size</th>
                <th className="text-right px-4 py-2 font-medium hidden md:table-cell">Modified</th>
                <th className="text-right px-4 py-2 font-medium w-8"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.path}
                  className={`group transition-colors cursor-pointer border-b border-[#0f0f1a] ${
                    selected === entry.path ? "bg-[#161625]" : "hover:bg-[#111120]"
                  }`}
                  onClick={() => setSelected(entry.path)}
                  onDoubleClick={() => navigate(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, entry });
                  }}
                >
                  <td className="px-4 py-2.5">
                    {renaming === entry.path ? (
                      <div className="flex items-center gap-2">
                        <FileIcon entry={entry} />
                        <input
                          autoFocus
                          className="bg-transparent border-b border-[#6366f1] text-white text-sm outline-none flex-1 font-mono"
                          value={renameVal}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          onBlur={commitRename}
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-2.5">
                        <FileIcon entry={entry} />
                        <span
                          className={`truncate ${entry.is_dir ? "text-[#818cf8] font-medium" : "text-[#c4cdd8]"}`}
                        >
                          {entry.name}
                          {entry.is_symlink && (
                            <span className="ml-1.5 text-[10px] text-[#00c8a8]">→ link</span>
                          )}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-[12px] text-[#374151] font-mono hidden sm:table-cell">
                    {entry.is_dir ? "—" : formatSize(entry.size)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-[12px] text-[#374151] hidden md:table-cell">
                    {formatDate(entry.modified)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {/* Quick download button for files */}
                    {!entry.is_dir && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDownload(entry); }}
                        className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-[#4b5563] hover:text-[#00c8a8] hover:bg-[#1e1e35] transition-all"
                        title="Download"
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M5 1v6M5 7L2.5 4.5M5 7L7.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M1 9H9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-[#1e1e35] flex items-center justify-between flex-shrink-0" style={{ background: "#0a0a14" }}>
        <span className="text-[11px] text-[#2d3748]">{entries.length} items</span>
        {selected && (
          <span className="text-[11px] text-[#4b5563] font-mono truncate max-w-xs">{selected}</span>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 rounded-xl border border-[#1e1e35] py-1 shadow-2xl"
          style={{ top: contextMenu.y, left: contextMenu.x, background: "#0f0f1a", minWidth: 160 }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.entry.is_dir ? (
            <button
              className="w-full text-left px-4 py-2 text-sm text-[#c4cdd8] hover:bg-[#1e1e35] hover:text-white transition-colors"
              onClick={() => { navigate(contextMenu.entry); setContextMenu(null); }}
            >
              Open folder
            </button>
          ) : (
            <button
              className="w-full text-left px-4 py-2 text-sm text-[#c4cdd8] hover:bg-[#1e1e35] hover:text-white transition-colors"
              onClick={() => handleDownload(contextMenu.entry)}
            >
              <span className="text-[#00c8a8] mr-2">↓</span> Download
            </button>
          )}
          <button
            className="w-full text-left px-4 py-2 text-sm text-[#c4cdd8] hover:bg-[#1e1e35] hover:text-white transition-colors"
            onClick={() => startRename(contextMenu.entry)}
          >
            Rename
          </button>
          <div className="h-px bg-[#1e1e35] my-1" />
          <button
            className="w-full text-left px-4 py-2 text-sm text-[#ef4444] hover:bg-[#1e1e35] transition-colors"
            onClick={() => handleDelete(contextMenu.entry)}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
