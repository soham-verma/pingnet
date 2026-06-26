import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  hostId: string;
  sessionId: string;
  isConnected: boolean;
}

// ── Raw data types from lsblk ─────────────────────────────────────────────────

interface LsblkNode {
  name:       string;
  size:       string;
  "size-raw"?: number;
  type:       string;          // "disk" | "part" | "lvm" | "md" | …
  fstype?:    string | null;
  label?:     string | null;
  mountpoint?: string | null;
  ro?:        boolean;
  uuid?:      string | null;
  partlabel?: string | null;
  children?:  LsblkNode[];
}

interface ParsedDisk {
  name:       string;      // sda, mmcblk0, nvme0n1 …
  size:       string;
  sizeBytes:  number;
  partitions: ParsedPart[];
}

interface ParsedPart {
  name:       string;
  label:      string | null;
  partlabel:  string | null;
  size:       string;
  sizeBytes:  number;
  sizePercent: number;     // fraction of parent disk
  fstype:     string | null;
  mountpoint: string | null;
  ro:         boolean;
  slot:       "a" | "b" | null;   // A/B detection
  isActive:   boolean;
}

type SchemeType = "android" | "uboot" | "gpt-labels" | "none" | "unknown";

interface ScanResult {
  disks:       ParsedDisk[];
  scheme:      SchemeType;
  activeSlot:  "a" | "b" | null;
  canSwitch:   boolean;
  switchCmd:   string | null;
  cmdline:     string;
  ubootEnv:    string;
  rawOutput:   string;
}

// ── Detection script ──────────────────────────────────────────────────────────

const SCAN_SCRIPT = `
echo "=== LSBLK ==="
lsblk -Jbo name,size,type,fstype,label,mountpoint,ro,uuid,partlabel 2>/dev/null || \
lsblk -bo NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINT,RO,UUID,PARTLABEL 2>/dev/null || echo "{}"
echo "=== CMDLINE ==="
cat /proc/cmdline 2>/dev/null || echo ""
echo "=== UBOOT ==="
fw_printenv 2>/dev/null || echo "no-uboot"
echo "=== PARTLABELS ==="
ls /dev/disk/by-partlabel/ 2>/dev/null || echo ""
echo "=== PARTED ==="
parted -lm 2>/dev/null || fdisk -l 2>/dev/null | head -60 || echo ""
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseSize(raw: string | number | undefined): number {
  if (typeof raw === "number") return raw;
  if (!raw) return 0;
  const s = String(raw).toUpperCase().replace(/,/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMGTPE]?B?)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = m[2] ?? "";
  if (u.startsWith("T")) return n * 1e12;
  if (u.startsWith("G")) return n * 1e9;
  if (u.startsWith("M")) return n * 1e6;
  if (u.startsWith("K")) return n * 1e3;
  return n;
}

function formatBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9)  return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6)  return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3)  return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

function detectSlot(name: string, label: string | null, partlabel: string | null): "a" | "b" | null {
  const targets = [name, label, partlabel].filter(Boolean).map((s) => s!.toLowerCase());
  for (const t of targets) {
    if (t.endsWith("_a") || t.endsWith("-a") || t === "system_a" || t === "boot_a" || t === "vendor_a") return "a";
    if (t.endsWith("_b") || t.endsWith("-b") || t === "system_b" || t === "boot_b" || t === "vendor_b") return "b";
  }
  return null;
}

const FS_COLORS: Record<string, string> = {
  ext4:    "#6366f1",
  ext3:    "#818cf8",
  ext2:    "#a5b4fc",
  btrfs:   "#22c55e",
  xfs:     "#16a34a",
  f2fs:    "#00c8a8",
  vfat:    "#f59e0b",
  fat32:   "#f59e0b",
  fat16:   "#fbbf24",
  ntfs:    "#3b82f6",
  swap:    "#6b7280",
  squashfs:"#8b5cf6",
  erofs:   "#7c3aed",
  jffs2:   "#d97706",
  ubifs:   "#ca8a04",
  tmpfs:   "#94a3b8",
  devtmpfs:"#94a3b8",
};

function fsColor(fstype: string | null, slot: "a" | "b" | null): string {
  if (slot === "a") return "#00c8a8";
  if (slot === "b") return "#6366f1";
  if (!fstype) return "#374151";
  return FS_COLORS[fstype.toLowerCase()] ?? "#64748b";
}

// ── Parser ────────────────────────────────────────────────────────────────────

function section(raw: string, name: string): string {
  const tag = `=== ${name} ===`;
  const start = raw.indexOf(tag);
  if (start === -1) return "";
  const next = raw.indexOf("===", start + tag.length);
  return (next === -1 ? raw.slice(start + tag.length) : raw.slice(start + tag.length, next)).trim();
}

function parseScan(raw: string): ScanResult {
  const lsblkRaw   = section(raw, "LSBLK");
  const cmdline    = section(raw, "CMDLINE");
  const ubootEnv   = section(raw, "UBOOT");
  const partlabels = section(raw, "PARTLABELS");

  // Detect active slot
  let activeSlot: "a" | "b" | null = null;
  let scheme: SchemeType = "unknown";
  let canSwitch = false;
  let switchCmd: string | null = null;

  const androidM = cmdline.match(/androidboot\.slot_suffix=_([ab])/i)
    ?? cmdline.match(/\bslot_suffix=_([ab])/i)
    ?? cmdline.match(/root=.*_([ab])\b/i);
  if (androidM) {
    activeSlot = androidM[1].toLowerCase() as "a" | "b";
    scheme = "android";
    canSwitch = !ubootEnv.includes("no-uboot");
    if (canSwitch) {
      const next = activeSlot === "a" ? "b" : "a";
      switchCmd = `fw_setenv slot_suffix _${next} && echo "Set active slot to ${next.toUpperCase()} — reboot to apply"`;
    }
  }
  if (!activeSlot && !ubootEnv.includes("no-uboot")) {
    const m = ubootEnv.match(/slot_suffix=_([ab])/i);
    if (m) {
      activeSlot = m[1].toLowerCase() as "a" | "b";
      scheme = "uboot";
      canSwitch = true;
      const next = activeSlot === "a" ? "b" : "a";
      switchCmd = `fw_setenv slot_suffix _${next} && echo "Set active slot to ${next.toUpperCase()} — reboot to apply"`;
    }
  }
  const hasAbLabels = /[_-][ab]\b/.test(partlabels.toLowerCase());
  if (hasAbLabels && scheme === "unknown") { scheme = "gpt-labels"; }
  if (scheme === "unknown") scheme = "none";

  // Parse lsblk JSON
  const disks: ParsedDisk[] = [];
  try {
    const json = JSON.parse(lsblkRaw) as { blockdevices?: LsblkNode[] };
    const nodes = json.blockdevices ?? [];
    for (const node of nodes) {
      if (node.type !== "disk") continue;
      const diskBytes = parseSize(node["size-raw"] ?? node.size);
      const parts: ParsedPart[] = [];
      for (const child of node.children ?? []) {
        if (child.type !== "part" && child.type !== "lvm" && child.type !== "md") continue;
        const pb   = parseSize(child["size-raw"] ?? child.size);
        const slot = detectSlot(child.name, child.label ?? null, child.partlabel ?? null);
        parts.push({
          name:        child.name,
          label:       child.label ?? null,
          partlabel:   child.partlabel ?? null,
          size:        child.size,
          sizeBytes:   pb,
          sizePercent: diskBytes > 0 ? pb / diskBytes : 0,
          fstype:      child.fstype ?? null,
          mountpoint:  child.mountpoint ?? null,
          ro:          Boolean(child.ro),
          slot,
          isActive:    slot !== null && slot === activeSlot,
        });
      }
      disks.push({ name: node.name, size: node.size, sizeBytes: diskBytes, partitions: parts });
    }
  } catch { /* JSON parse failed — leave disks empty */ }

  return { disks, scheme, activeSlot, canSwitch, switchCmd, cmdline, ubootEnv, rawOutput: raw };
}

// ── Disk bar (GParted-style) ──────────────────────────────────────────────────

function DiskBar({ disk, activeSlot, selectedPart, onSelect }: {
  disk:        ParsedDisk;
  activeSlot:  "a" | "b" | null;
  selectedPart: string | null;
  onSelect:    (name: string) => void;
}) {
  const MIN_PCT = 2; // min visual width so tiny partitions are still clickable
  // Normalise so bars fill 100 %
  const total = disk.partitions.reduce((s, p) => s + p.sizeBytes, 0) || disk.sizeBytes || 1;

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 mb-2">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="1" y="3" width="12" height="8" rx="1.5" stroke="var(--text3)" strokeWidth="1.2" />
          <path d="M3 5.5h8M3 8h5" stroke="var(--text3)" strokeWidth="0.9" strokeLinecap="round" strokeOpacity="0.5" />
        </svg>
        <span className="font-mono text-[12px] text-[var(--text2)]">/dev/{disk.name}</span>
        <span className="text-[11px] text-[var(--text4)]">{disk.size}</span>
      </div>

      {/* The bar */}
      <div className="flex h-10 rounded-lg overflow-hidden border border-[var(--border)] gap-px bg-[var(--border)]">
        {disk.partitions.length === 0 ? (
          <div className="flex-1 flex items-center justify-center bg-[var(--bg)] text-[11px] text-[var(--text4)]">
            Unpartitioned / empty
          </div>
        ) : disk.partitions.map((p) => {
          const pct = Math.max(MIN_PCT, (p.sizeBytes / total) * 100);
          const color = fsColor(p.fstype, p.slot);
          const isSelected = selectedPart === p.name;
          return (
            <button
              key={p.name}
              onClick={() => onSelect(p.name)}
              title={`${p.name}  ${p.size}  ${p.fstype ?? "raw"}${p.mountpoint ? `  ${p.mountpoint}` : ""}`}
              className="flex flex-col items-center justify-center transition-all relative overflow-hidden"
              style={{
                width: `${pct}%`,
                background: isSelected ? `${color}` : `${color}88`,
                outline: isSelected ? `2px solid ${color}` : "none",
                outlineOffset: "-2px",
              }}
            >
              {pct > 8 && (
                <span className="font-mono text-[9px] font-semibold leading-none px-0.5 truncate max-w-full"
                  style={{ color: "rgba(255,255,255,0.85)" }}>
                  {p.name.replace(/^.*\//, "")}
                </span>
              )}
              {pct > 12 && p.fstype && (
                <span className="text-[8px] leading-none opacity-70" style={{ color: "rgba(255,255,255,0.75)" }}>
                  {p.fstype}
                </span>
              )}
              {/* A/B slot badge */}
              {p.slot && pct > 6 && (
                <span className="absolute top-0.5 right-0.5 text-[7px] font-bold leading-none opacity-80 text-white">
                  {p.slot.toUpperCase()}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Mini legend */}
      <div className="flex flex-wrap gap-2 mt-1.5">
        {disk.partitions.map((p) => {
          const color = fsColor(p.fstype, p.slot);
          return (
            <button
              key={p.name}
              onClick={() => onSelect(p.name)}
              className="flex items-center gap-1 text-[10px] transition-opacity"
              style={{ opacity: selectedPart && selectedPart !== p.name ? 0.45 : 1 }}
            >
              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: color }} />
              <span className="font-mono text-[var(--text3)]">{p.name.replace(/^.*\//, "")}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Partition detail table ─────────────────────────────────────────────────────

function PartTable({ partitions, activeSlot, selectedPart, onSelect }: {
  partitions: ParsedPart[];
  activeSlot: "a" | "b" | null;
  selectedPart: string | null;
  onSelect: (name: string) => void;
}) {
  return (
    <table className="w-full text-[11px]" style={{ borderCollapse: "separate", borderSpacing: "0 2px" }}>
      <thead>
        <tr className="text-[9px] tracking-widest text-[var(--text4)] uppercase">
          {["Name", "Size", "File System", "Label", "Mount", "Flags"].map((h) => (
            <th key={h} className="text-left px-2 py-1 font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {partitions.map((p) => {
          const color = fsColor(p.fstype, p.slot);
          const isSelected = selectedPart === p.name;
          return (
            <tr
              key={p.name}
              onClick={() => onSelect(p.name)}
              className="cursor-pointer transition-colors"
              style={{
                background: isSelected ? `${color}18` : "transparent",
                outline: isSelected ? `1px solid ${color}30` : "none",
              }}
            >
              {/* Name + slot badge */}
              <td className="px-2 py-1.5 rounded-l font-mono text-[var(--text)]">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: color }} />
                  {p.name.replace(/^.*\//, "")}
                  {p.slot && (
                    <span
                      className="text-[8px] px-1 py-0.5 rounded font-bold"
                      style={{ background: `${color}25`, color }}
                    >
                      {p.slot.toUpperCase()}
                    </span>
                  )}
                  {p.isActive && (
                    <span className="text-[8px] px-1 py-0.5 rounded font-bold bg-[#00c8a820] text-[#00c8a8]">
                      live
                    </span>
                  )}
                </div>
              </td>
              <td className="px-2 py-1.5 font-mono text-[var(--text3)]">{p.size}</td>
              <td className="px-2 py-1.5 text-[var(--text3)]">{p.fstype ?? <span className="text-[var(--text5)]">—</span>}</td>
              <td className="px-2 py-1.5 text-[var(--text4)] max-w-[100px] truncate">
                {p.partlabel ?? p.label ?? <span className="text-[var(--text5)]">—</span>}
              </td>
              <td className="px-2 py-1.5 font-mono text-[var(--text4)] max-w-[80px] truncate">
                {p.mountpoint ?? <span className="text-[var(--text5)]">—</span>}
              </td>
              <td className="px-2 py-1.5 rounded-r">
                <div className="flex items-center gap-1">
                  {p.ro && <span className="text-[8px] px-1 py-0.5 rounded bg-[#ef444415] text-[#ef4444]">ro</span>}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── A/B slot switcher header ───────────────────────────────────────────────────

function SlotBar({ result, onSwitch }: { result: ScanResult; onSwitch: (target: "a" | "b") => void }) {
  if (result.scheme === "none" || !result.activeSlot) return null;
  const target: "a" | "b" = result.activeSlot === "a" ? "b" : "a";
  return (
    <div
      className="flex items-center gap-3 px-5 py-2.5 border-b border-[var(--border)] flex-shrink-0 text-[11px]"
      style={{ background: "rgba(0,200,168,0.04)" }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="flex-shrink-0">
        <rect x="1" y="2" width="5" height="10" rx="1" stroke="#00c8a8" strokeWidth="1.2" />
        <rect x="8" y="2" width="5" height="10" rx="1" stroke="#6366f1" strokeWidth="1.2" strokeOpacity="0.5" />
        <path d="M3.5 6.5L3.5 7.5M10.5 6.5L10.5 7.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeOpacity="0.4" />
      </svg>
      <span className="text-[var(--text3)]">A/B Seamless Updates</span>
      <div className="flex items-center gap-2 ml-2">
        {(["a", "b"] as const).map((s) => (
          <span
            key={s}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full font-medium text-[10px]"
            style={
              result.activeSlot === s
                ? { background: "#00c8a815", color: "#00c8a8", border: "1px solid #00c8a830" }
                : { background: "#6366f110", color: "#818cf8", border: "1px solid #6366f120" }
            }
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: result.activeSlot === s ? "#00c8a8" : "#6366f140" }} />
            Slot {s.toUpperCase()} {result.activeSlot === s && "(active)"}
          </span>
        ))}
      </div>
      <div className="flex-1" />
      {result.canSwitch && (
        <button
          onClick={() => onSwitch(target)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all"
          style={{ background: "#f59e0b18", color: "#f59e0b", border: "1px solid #f59e0b30" }}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M1 5.5h9M6 2l4 3.5L6 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Switch to Slot {target.toUpperCase()}
        </button>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

type PanelTab = "visual" | "table" | "raw";

export default function ABPartitionPanel({ hostId, sessionId, isConnected }: Props) {
  const [loading, setLoading]             = useState(false);
  const [result,  setResult]              = useState<ScanResult | null>(null);
  const [error,   setError]               = useState<string | null>(null);
  const [selectedDisk, setSelectedDisk]   = useState<string | null>(null);
  const [selectedPart, setSelectedPart]   = useState<string | null>(null);
  const [panelTab, setPanelTab]           = useState<PanelTab>("visual");
  const [switchTarget, setSwitchTarget]   = useState<"a" | "b" | null>(null);
  const [switching, setSwitching]         = useState(false);

  const scan = useCallback(async () => {
    if (!isConnected || !sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const raw = await invoke<string>("ssh_exec", {
        sessionId,
        command: SCAN_SCRIPT,
      });
      const parsed = parseScan(raw);
      setResult(parsed);
      if (parsed.disks.length > 0 && !selectedDisk) {
        setSelectedDisk(parsed.disks[0].name);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [hostId, sessionId, isConnected, selectedDisk]);

  const doSwitch = useCallback(async (target: "a" | "b") => {
    if (!result?.switchCmd || !sessionId) return;
    setSwitching(true);
    try {
      await invoke<string>("ssh_exec", { sessionId, command: result.switchCmd });
      await scan();
    } catch (e) {
      setError(`Slot switch failed: ${e}`);
    } finally {
      setSwitching(false);
      setSwitchTarget(null);
    }
  }, [result, hostId, sessionId, scan]);

  const activeDisk  = result?.disks.find((d) => d.name === selectedDisk) ?? result?.disks[0] ?? null;
  const allPartitions = activeDisk?.partitions ?? [];

  // ── Idle state ──────────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-8">
        <svg className="mb-4 opacity-30" width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect x="3" y="8" width="34" height="24" rx="3" stroke="currentColor" strokeWidth="2" />
          <path d="M10 16h20M10 22h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeOpacity="0.5" />
        </svg>
        <p className="text-[var(--text3)] text-sm">Connect via SSH to manage partitions</p>
      </div>
    );
  }

  if (!result && !loading && !error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-8">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5" style={{ background: "var(--bg2)", border: "1px solid var(--border)" }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect x="2" y="6" width="24" height="16" rx="2.5" stroke="#6366f1" strokeWidth="1.6" />
            {/* partition separators */}
            <line x1="9" y1="6" x2="9" y2="22" stroke="#6366f1" strokeWidth="1.2" strokeOpacity="0.5" />
            <line x1="18" y1="6" x2="18" y2="22" stroke="#6366f1" strokeWidth="1.2" strokeOpacity="0.5" />
            {/* A/B labels */}
            <text x="4.5" y="16" fontSize="5" fill="#00c8a8" fontWeight="bold">A</text>
            <text x="13" y="16" fontSize="5" fill="#6366f1" fontWeight="bold">B</text>
          </svg>
        </div>
        <h3 className="text-[var(--text)] font-semibold mb-1">Partition Manager</h3>
        <p className="text-[var(--text3)] text-sm mb-5 max-w-xs">
          Visualise disk layout, detect A/B slots, and switch boot targets — all over SSH.
        </p>
        <button
          onClick={scan}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all"
          style={{ background: "#6366f1", color: "#fff", boxShadow: "0 0 16px #6366f130" }}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M6.5 1v2M6.5 10v2M1 6.5h2M10 6.5h2M2.9 2.9l1.4 1.4M8.7 8.7l1.4 1.4M2.9 10.1l1.4-1.4M8.7 4.3l1.4-1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          Scan Disks
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="w-7 h-7 rounded-full border-2 border-[#6366f1] border-t-transparent animate-spin" />
        <p className="text-[var(--text3)] text-sm">Scanning disk layout…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-8 text-center">
        <p className="text-[#ef4444] text-sm">{error}</p>
        <button onClick={scan} className="px-4 py-2 rounded-lg text-sm font-medium text-[#6366f1] border border-[#6366f130] hover:border-[#6366f1] transition-colors">Retry</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* A/B slot bar */}
      {result && <SlotBar result={result} onSwitch={(t) => setSwitchTarget(t)} />}

      {/* Toolbar */}
      <div
        className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border)] flex-shrink-0"
        style={{ background: "var(--bg1)" }}
      >
        {/* Disk selector */}
        {(result?.disks.length ?? 0) > 1 && (
          <div className="flex items-center gap-1.5">
            {result!.disks.map((d) => (
              <button
                key={d.name}
                onClick={() => { setSelectedDisk(d.name); setSelectedPart(null); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all"
                style={
                  selectedDisk === d.name
                    ? { background: "#6366f1", color: "#fff" }
                    : { background: "var(--bg)", color: "var(--text3)", border: "1px solid var(--border)" }
                }
              >
                /dev/{d.name}
                <span className="opacity-60">{d.size}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1" />

        {/* View mode tabs */}
        <div className="flex items-center gap-1 bg-[var(--bg)] rounded-lg p-0.5 border border-[var(--border)]">
          {(["visual", "table", "raw"] as PanelTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setPanelTab(t)}
              className="px-3 py-1.5 rounded-md text-[11px] font-medium transition-all capitalize"
              style={
                panelTab === t
                  ? { background: "var(--border)", color: "var(--text)" }
                  : { color: "var(--text3)" }
              }
            >
              {t}
            </button>
          ))}
        </div>

        <button
          onClick={scan}
          title="Re-scan"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M12 6.5A5.5 5.5 0 1 1 6.5 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M12 1v5.5H6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {panelTab === "raw" ? (
          <pre className="font-mono text-[11px] text-[var(--text3)] whitespace-pre-wrap p-5 leading-relaxed">
            {result?.rawOutput}
          </pre>
        ) : panelTab === "visual" ? (
          <div className="p-5 space-y-6">
            {result?.disks.length === 0 ? (
              <div className="flex flex-col items-center py-12 text-center text-[var(--text4)]">
                <p className="text-sm">No disks detected — lsblk may not be available on this host</p>
                <button onClick={() => setPanelTab("raw")} className="mt-2 text-[11px] text-[#6366f1] hover:underline">View raw output</button>
              </div>
            ) : (
              result!.disks.map((disk) => (
                <div key={disk.name}>
                  <DiskBar
                    disk={disk}
                    activeSlot={result!.activeSlot}
                    selectedPart={selectedPart}
                    onSelect={setSelectedPart}
                  />
                  {/* Selected partition detail */}
                  {selectedPart && disk.partitions.find((p) => p.name === selectedPart) && (() => {
                    const p = disk.partitions.find((p) => p.name === selectedPart)!;
                    const color = fsColor(p.fstype, p.slot);
                    return (
                      <div
                        className="mt-3 rounded-xl border p-4 grid grid-cols-3 gap-3 text-[11px]"
                        style={{ background: `${color}08`, borderColor: `${color}30` }}
                      >
                        {[
                          ["Partition", p.name],
                          ["Size", p.size],
                          ["File system", p.fstype ?? "—"],
                          ["Mount", p.mountpoint ?? "—"],
                          ["Label", p.partlabel ?? p.label ?? "—"],
                          ["Flags", p.ro ? "read-only" : "read-write"],
                        ].map(([k, v]) => (
                          <div key={k}>
                            <div className="text-[9px] tracking-widest text-[var(--text4)] uppercase mb-0.5">{k}</div>
                            <div className="font-mono text-[var(--text)] truncate">{v}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              ))
            )}
          </div>
        ) : (
          /* Table view */
          <div className="p-5">
            {activeDisk && (
              <PartTable
                partitions={allPartitions}
                activeSlot={result!.activeSlot}
                selectedPart={selectedPart}
                onSelect={setSelectedPart}
              />
            )}
          </div>
        )}
      </div>

      {/* FS legend strip */}
      {panelTab === "visual" && (result?.disks.length ?? 0) > 0 && (
        <div
          className="flex-shrink-0 flex items-center gap-3 px-5 py-2.5 border-t border-[var(--border)] overflow-x-auto"
          style={{ background: "var(--bg1)" }}
        >
          <span className="text-[9px] tracking-widest text-[var(--text4)] uppercase flex-shrink-0">Legend</span>
          {[
            { label: "Slot A (active)", color: "#00c8a8" },
            { label: "Slot B",          color: "#6366f1" },
            { label: "ext4",            color: FS_COLORS.ext4 },
            { label: "btrfs",           color: FS_COLORS.btrfs },
            { label: "vfat",            color: FS_COLORS.vfat },
            { label: "swap",            color: FS_COLORS.swap },
            { label: "squashfs",        color: FS_COLORS.squashfs },
          ].map(({ label, color }) => (
            <span key={label} className="flex items-center gap-1 flex-shrink-0 text-[10px] text-[var(--text4)]">
              <span className="w-2 h-2 rounded-sm" style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
      )}

      {/* Switch confirmation */}
      {switchTarget && result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] p-6" style={{ background: "var(--bg2)" }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#f59e0b18" }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path d="M9 2L16 15H2L9 2Z" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M9 7v4M9 13v1" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-[var(--text)]">Switch to Slot {switchTarget.toUpperCase()}?</h3>
                <p className="text-[12px] text-[var(--text3)]">Takes effect on next reboot</p>
              </div>
            </div>
            {result.switchCmd && (
              <pre className="font-mono text-[11px] text-[var(--text3)] bg-[var(--bg)] rounded-lg p-3 mb-4 border border-[var(--border)] whitespace-pre-wrap">{result.switchCmd}</pre>
            )}
            <div className="flex gap-2">
              <button onClick={() => setSwitchTarget(null)} className="flex-1 py-2.5 rounded-xl text-sm text-[var(--text3)] border border-[var(--border)] hover:text-[var(--text)] transition-colors">
                Cancel
              </button>
              <button
                onClick={() => doSwitch(switchTarget)}
                disabled={switching}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center"
                style={{ background: "#f59e0b", color: "#000" }}
              >
                {switching
                  ? <span className="w-4 h-4 rounded-full border-2 border-black border-t-transparent animate-spin" />
                  : "Switch Slot"
                }
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
