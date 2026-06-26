import { useState, useEffect, useMemo } from "react";

// ── Data ─────────────────────────────────────────────────────────────────────

interface Shortcut {
  action: string;
  keys: string[][];  // each outer array = one alternative combo; inner = keys to press together
  note?: string;
}

interface Category {
  id: string;
  label: string;
  shortcuts: Shortcut[];
}

const CATEGORIES: Category[] = [
  {
    id: "navigation",
    label: "Navigation",
    shortcuts: [
      { action: "Navigate host list",     keys: [["↑"], ["↓"]] },
      { action: "Jump to host by index",  keys: [["1"], ["2"], ["…"], ["9"]], note: "1–9" },
      { action: "Add new host",           keys: [["N"]] },
      { action: "Edit selected host",     keys: [["E"]] },
      { action: "Open SSH session",       keys: [["S"]] },
      { action: "Toggle sidebar",         keys: [["⌘", "B"]] },
    ],
  },
  {
    id: "ping",
    label: "Ping",
    shortcuts: [
      { action: "Run ping",               keys: [["Enter"]] },
      { action: "Stop pinging",           keys: [["Esc"]] },
      { action: "Clear ping history",     keys: [["⌫"]], note: "when host is selected" },
    ],
  },
  {
    id: "ssh",
    label: "SSH Terminal",
    shortcuts: [
      { action: "New terminal tab",       keys: [["⌘", "T"]] },
      { action: "Close tab",             keys: [["⌘", "W"]] },
      { action: "Switch to tab N",        keys: [["⌘", "1"]], note: "⌘1–⌘9" },
      { action: "Split terminal",         keys: [["⌘", "D"]] },
      { action: "Focus left / right pane",keys: [["⌘", "⌥", "←"], ["⌘", "⌥", "→"]] },
      { action: "Interrupt process",      keys: [["Ctrl", "C"]] },
      { action: "Clear terminal",         keys: [["Ctrl", "L"]] },
      { action: "Search command history", keys: [["Ctrl", "R"]] },
      { action: "End of line",            keys: [["Ctrl", "E"]] },
      { action: "Beginning of line",      keys: [["Ctrl", "A"]] },
    ],
  },
  {
    id: "files",
    label: "File Manager",
    shortcuts: [
      { action: "Go up a directory",      keys: [["⌘", "↑"]] },
      { action: "Download file",          keys: [["⌘", "D"]] },
      { action: "New folder",             keys: [["⌘", "Shift", "N"]] },
      { action: "Delete selected",        keys: [["⌫"]] },
      { action: "Rename item",            keys: [["Enter"]] },
    ],
  },
  {
    id: "global",
    label: "Global",
    shortcuts: [
      { action: "Show shortcuts",         keys: [["?"]] },
      { action: "Open Key Manager",       keys: [["⌘", "K"]] },
      { action: "Toggle dark / light",    keys: [["⌘", "Shift", "D"]] },
      { action: "Check for updates",      keys: [["⌘", "Shift", "U"]] },
    ],
  },
];

// ── Key chip ──────────────────────────────────────────────────────────────────

function KeyChip({ k }: { k: string }) {
  const isSymbol = ["⌘", "⌥", "Ctrl", "Shift", "Alt", "↑", "↓", "←", "→", "⌫", "Enter", "Esc", "Tab"].includes(k);
  return (
    <kbd
      className="inline-flex items-center justify-center rounded-md text-[11px] font-medium px-2 py-0.5 min-w-[24px] leading-5 flex-shrink-0"
      style={{
        background: "var(--bg2)",
        border: "1px solid var(--border)",
        color: "var(--text2)",
        fontFamily: isSymbol ? "inherit" : "ui-monospace, monospace",
        boxShadow: "0 1px 0 var(--border)",
      }}
    >
      {k}
    </kbd>
  );
}

function Combo({ keys }: { keys: string[] }) {
  return (
    <div className="flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-[9px] text-[var(--text5)]">+</span>}
          <KeyChip k={k} />
        </span>
      ))}
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
}

export default function ShortcutsModal({ onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("navigation");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Filter across ALL categories when searching
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return null;
    const results: (Shortcut & { categoryLabel: string })[] = [];
    for (const cat of CATEGORIES) {
      for (const s of cat.shortcuts) {
        const match = s.action.toLowerCase().includes(q)
          || s.keys.flat().join(" ").toLowerCase().includes(q);
        if (match) results.push({ ...s, categoryLabel: cat.label });
      }
    }
    return results;
  }, [query]);

  const currentCategory = CATEGORIES.find((c) => c.id === activeCategory) ?? CATEGORIES[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4"
      style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-lg rounded-2xl overflow-hidden flex flex-col"
        style={{
          background: "var(--bg2)",
          border: "1px solid var(--border)",
          boxShadow: "0 32px 80px rgba(0,0,0,0.5)",
          maxHeight: "80vh",
        }}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex-shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[var(--text)] font-semibold text-base">Keyboard Shortcuts</h2>
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all text-base"
            >
              ×
            </button>
          </div>

          {/* Search */}
          <div
            className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-[var(--border)] focus-within:border-[#6366f1] transition-colors"
            style={{ background: "var(--bg)" }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0 text-[var(--text4)]">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M10 10l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts…"
              className="flex-1 bg-transparent text-sm text-[var(--text)] placeholder-[var(--text4)] outline-none"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-[var(--text4)] hover:text-[var(--text)] transition-colors text-sm">×</button>
            )}
          </div>

          {/* Category tabs — hide when searching */}
          {!query && (
            <div className="flex gap-1 mt-4 overflow-x-auto pb-0.5">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id)}
                  className="flex-shrink-0 px-4 py-2 rounded-lg text-[12px] font-medium transition-all"
                  style={
                    activeCategory === cat.id
                      ? { background: "#6366f1", color: "#fff" }
                      : { color: "var(--text3)", background: "var(--bg)" }
                  }
                >
                  {cat.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Shortcut list */}
        <div className="overflow-y-auto flex-1 px-4 pb-4">
          {filtered !== null ? (
            /* Search results */
            filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="text-3xl mb-3 opacity-30">⌨</div>
                <p className="text-[var(--text3)] text-sm">No shortcuts match "<span className="text-[var(--text)]">{query}</span>"</p>
              </div>
            ) : (
              <div className="space-y-1">
                {filtered.map((s, i) => (
                  <ShortcutRow key={i} shortcut={s} categoryLabel={s.categoryLabel} />
                ))}
              </div>
            )
          ) : (
            /* Category view */
            <div>
              <p className="text-[11px] tracking-widest text-[#6366f1] uppercase font-medium mb-3 px-2 pt-2">
                {currentCategory.label}
              </p>
              <div className="space-y-1">
                {currentCategory.shortcuts.map((s, i) => (
                  <ShortcutRow key={i} shortcut={s} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-6 py-3 border-t border-[var(--border)] flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <KeyChip k="?" />
            <span className="text-[11px] text-[var(--text4)]">to toggle this panel anywhere</span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <KeyChip k="Esc" />
            <span className="text-[11px] text-[var(--text4)]">close</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Row component ─────────────────────────────────────────────────────────────

function ShortcutRow({ shortcut, categoryLabel }: { shortcut: Shortcut; categoryLabel?: string }) {
  return (
    <div
      className="flex items-center justify-between gap-4 px-3 py-2.5 rounded-xl transition-colors hover:bg-[var(--bg)]"
    >
      <div className="min-w-0">
        <span className="text-sm text-[var(--text)]">{shortcut.action}</span>
        {shortcut.note && (
          <span className="ml-2 text-[11px] text-[var(--text4)]">{shortcut.note}</span>
        )}
        {categoryLabel && (
          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: "#6366f120", color: "#818cf8" }}>
            {categoryLabel}
          </span>
        )}
      </div>
      {/* Key combos — "or" separated */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {shortcut.keys.slice(0, 2).map((combo, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-[10px] text-[var(--text5)]">or</span>}
            <Combo keys={combo} />
          </span>
        ))}
      </div>
    </div>
  );
}
