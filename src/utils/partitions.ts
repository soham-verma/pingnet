// Partition scan script, parsers, and shared types for cross-platform disk layout.

export const PART_SCAN_SCRIPT = `
OS=$(uname -s 2>/dev/null || echo "Unknown")
echo "=== PLATFORM ===$OS"
if [ "$OS" = "Darwin" ]; then
  echo "=== DISKUTIL ==="
  diskutil list 2>/dev/null || echo "unavailable"
  echo "=== DF ==="
  df -Hl 2>/dev/null | tail -n +2 || echo ""
elif [ "$OS" = "Linux" ]; then
  echo "=== LSBLK ==="
  lsblk -Jbo name,size,type,fstype,label,mountpoint,ro,partlabel 2>/dev/null || echo "null"
  echo "=== PROC_PARTS ==="
  cat /proc/partitions 2>/dev/null || echo ""
  echo "=== BLKID ==="
  blkid 2>/dev/null || echo ""
  echo "=== DF ==="
  df -h 2>/dev/null | tail -n +2 | head -25 || echo ""
  echo "=== CMDLINE ==="
  cat /proc/cmdline 2>/dev/null || echo ""
  echo "=== UBOOT ==="
  fw_printenv 2>/dev/null || echo "no-uboot"
else
  echo "=== GPART ==="
  gpart show -p 2>/dev/null || echo ""
  echo "=== DF ==="
  df -h 2>/dev/null | tail -n +2 | head -25 || echo ""
fi
`.trim();

export interface PartNode {
  name: string;
  size: string;
  type: string;
  fstype?: string | null;
  label?: string | null;
  mountpoint?: string | null;
  ro?: boolean;
  partlabel?: string | null;
  children?: PartNode[];
}

export interface PartEntry {
  name: string;
  label: string | null;
  size: string;
  sizeBytes: number;
  sizePct: number;
  fstype: string | null;
  mountpoint: string | null;
  ro: boolean;
  slot: "a" | "b" | null;
}

export interface DiskEntry {
  name: string;
  size: string;
  sizeBytes: number;
  parts: PartEntry[];
}

export interface PartScan {
  disks: DiskEntry[];
  activeSlot: "a" | "b" | null;
  platform: string;
  method: string;
  /** Set when A/B slot switching is available (Linux embedded). */
  switchCmd: string | null;
}

export const PART_FS_COLORS: Record<string, string> = {
  ext4: "#6366f1", ext3: "#818cf8", ext2: "#a5b4fc", btrfs: "#22c55e", xfs: "#16a34a", f2fs: "#00c8a8",
  vfat: "#f59e0b", fat32: "#f59e0b", fat16: "#fbbf24", ntfs: "#3b82f6", swap: "#6b7280",
  squashfs: "#8b5cf6", erofs: "#7c3aed", jffs2: "#d97706", ubifs: "#ca8a04", tmpfs: "#94a3b8",
  apfs: "#ec4899", "hfs+": "#db2777", exfat: "#0ea5e9",
};

export function partFsColor(fs: string | null, slot: "a" | "b" | null): string {
  if (slot === "a") return "#00c8a8";
  if (slot === "b") return "#6366f1";
  if (!fs) return "#374151";
  return PART_FS_COLORS[fs.toLowerCase()] ?? "#64748b";
}

export function detectPartSlot(name: string, label: string | null, pl: string | null): "a" | "b" | null {
  for (const s of [name, label, pl].filter(Boolean).map((x) => x!.toLowerCase())) {
    if (s.endsWith("_a") || s.endsWith("-a") || s === "boot_a" || s === "system_a") return "a";
    if (s.endsWith("_b") || s.endsWith("-b") || s === "boot_b" || s === "system_b") return "b";
  }
  return null;
}

export function parseSizeUnit(val: number, unit: string): number {
  const u = unit.toUpperCase();
  if (u.startsWith("T")) return val * 1e12;
  if (u.startsWith("G")) return val * 1e9;
  if (u.startsWith("M")) return val * 1e6;
  if (u.startsWith("K")) return val * 1e3;
  return val;
}

export function parsePartSizeBytes(raw: string | number | undefined): number {
  if (typeof raw === "number") return raw;
  if (!raw) return 0;
  const s = String(raw).toUpperCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B?)?$/);
  if (!m) return 0;
  return parseSizeUnit(parseFloat(m[1]), m[2] ?? "");
}

export function fmtPartBytes(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

export function partSec(raw: string, name: string): string {
  const tag = `=== ${name} ===`;
  const s = raw.indexOf(tag);
  if (s === -1) return "";
  const e = raw.indexOf("===", s + tag.length);
  return (e === -1 ? raw.slice(s + tag.length) : raw.slice(s + tag.length, e)).trim();
}

export function buildDfMap(dfText: string): { mountMap: Record<string, string>; sizeMap: Record<string, string> } {
  const mountMap: Record<string, string> = {};
  const sizeMap: Record<string, string> = {};
  for (const line of dfText.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const dev = parts[0].replace(/^\/dev\//, "");
    const mount = parts[parts.length - 1];
    if (mount.startsWith("/")) mountMap[dev] = mount;
    if (parts.length >= 4) sizeMap[dev] = parts[1];
  }
  return { mountMap, sizeMap };
}

function parseLsblkJson(lsblkRaw: string, activeSlot: "a" | "b" | null): PartScan {
  const disks: DiskEntry[] = [];
  const json = JSON.parse(lsblkRaw) as { blockdevices?: PartNode[] };
  for (const node of json.blockdevices ?? []) {
    if (node.type !== "disk") continue;
    const db = parsePartSizeBytes(node.size);
    const parts: PartEntry[] = [];
    for (const child of node.children ?? []) {
      if (!["part", "lvm", "md", "crypt"].includes(child.type)) continue;
      const pb = parsePartSizeBytes(child.size);
      const slot = detectPartSlot(child.name, child.label ?? null, child.partlabel ?? null);
      parts.push({
        name: child.name,
        label: child.partlabel ?? child.label ?? null,
        size: child.size,
        sizeBytes: pb,
        sizePct: db > 0 ? pb / db : 0,
        fstype: child.fstype ?? null,
        mountpoint: child.mountpoint ?? null,
        ro: Boolean(child.ro),
        slot,
      });
    }
    disks.push({ name: node.name, size: node.size, sizeBytes: db, parts });
  }
  return { disks, activeSlot, platform: "Linux", method: "lsblk", switchCmd: null };
}

function isPartOf(part: string, disk: string): boolean {
  if (part === disk || !part.startsWith(disk)) return false;
  const s = part.slice(disk.length);
  return /^\d+$/.test(s) || /^p\d+$/.test(s);
}

function parseProcPartitions(
  partsText: string,
  blkidText: string,
  dfText: string,
  activeSlot: "a" | "b" | null,
): PartScan {
  const fsMap: Record<string, string> = {};
  for (const line of blkidText.split("\n")) {
    const dm = line.match(/^\/dev\/(\S+?):\s+.*?\bTYPE="([^"]+)"/);
    if (dm) fsMap[dm[1]] = dm[2];
  }
  const { mountMap } = buildDfMap(dfText);

  const entries: { name: string; bytes: number }[] = [];
  for (const line of partsText.split("\n")) {
    const m = line.trim().match(/^\d+\s+\d+\s+(\d+)\s+(\S+)$/);
    if (!m || m[2] === "name") continue;
    if (/^(loop|ram|zram)/.test(m[2])) continue;
    entries.push({ name: m[2], bytes: parseInt(m[1]) * 1024 });
  }

  const diskNames = new Set(
    entries.filter((e) => !entries.some((d) => d.name !== e.name && isPartOf(e.name, d.name))).map((e) => e.name),
  );
  const disksMap = new Map<string, DiskEntry>();
  for (const e of entries) {
    if (diskNames.has(e.name)) {
      disksMap.set(e.name, { name: e.name, size: fmtPartBytes(e.bytes), sizeBytes: e.bytes, parts: [] });
    }
  }
  for (const e of entries) {
    if (diskNames.has(e.name)) continue;
    const parent = entries.find((d) => diskNames.has(d.name) && isPartOf(e.name, d.name));
    if (!parent) continue;
    const disk = disksMap.get(parent.name)!;
    disk.parts.push({
      name: e.name,
      label: null,
      size: fmtPartBytes(e.bytes),
      sizeBytes: e.bytes,
      sizePct: disk.sizeBytes > 0 ? e.bytes / disk.sizeBytes : 0,
      fstype: fsMap[e.name] ?? null,
      mountpoint: mountMap[e.name] ?? null,
      ro: false,
      slot: detectPartSlot(e.name, null, null),
    });
  }
  return { disks: Array.from(disksMap.values()), activeSlot, platform: "Linux", method: "/proc/partitions", switchCmd: null };
}

const MAC_TYPE_MAP: Record<string, string> = {
  EFI: "vfat",
  Apple_APFS: "apfs",
  "APFS Volume": "apfs",
  "APFS Snapshot": "apfs",
  Apple_HFS: "hfs+",
  Apple_Boot: "hfs+",
  Apple_Recovery: "hfs+",
  "Microsoft Basic Data": "ntfs",
  "Linux Filesystem": "ext4",
  "Linux swap": "swap",
  GUID_partition_scheme: "gpt",
  FDisk_partition_scheme: "mbr",
};

function parseDiskutil(text: string, dfText: string): PartScan {
  const { mountMap } = buildDfMap(dfText);
  const disks: DiskEntry[] = [];
  let curr: DiskEntry | null = null;

  for (const line of text.split("\n")) {
    const dh = line.match(/^(\/dev\/disk\d+)\s*\(([^)]*)\):/);
    if (dh) {
      curr = { name: dh[1].replace("/dev/", ""), size: "", sizeBytes: 0, parts: [] };
      disks.push(curr);
      continue;
    }
    if (!curr || line.includes("#:")) continue;

    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 4) continue;
    const idxM = tokens[0].match(/^(\d+):$/);
    if (!idxM) continue;

    const identifier = tokens[tokens.length - 1];
    const unit = tokens[tokens.length - 2];
    if (!["B", "KB", "MB", "GB", "TB"].includes(unit)) continue;
    const sizeRaw = tokens[tokens.length - 3].replace("*", "");
    const sizeNum = parseFloat(sizeRaw);
    if (isNaN(sizeNum)) continue;

    const sizeBytes = parseSizeUnit(sizeNum, unit);
    const sizeStr = `${sizeNum} ${unit}`;
    const typeStr = tokens.slice(1, tokens.length - 3).join(" ").replace(/\*/g, "").trim();

    if (parseInt(idxM[1]) === 0) {
      curr.size = sizeStr;
      curr.sizeBytes = sizeBytes;
    } else {
      let fstype: string | null = null;
      for (const [k, v] of Object.entries(MAC_TYPE_MAP)) {
        if (typeStr.startsWith(k)) {
          fstype = v;
          break;
        }
      }
      curr.parts.push({
        name: identifier,
        label: typeStr || null,
        size: sizeStr,
        sizeBytes,
        sizePct: curr.sizeBytes > 0 ? sizeBytes / curr.sizeBytes : 0,
        fstype,
        mountpoint: mountMap[identifier] ?? null,
        ro: false,
        slot: null,
      });
    }
  }

  return { disks: disks.filter((d) => d.sizeBytes > 0), activeSlot: null, platform: "macOS", method: "diskutil", switchCmd: null };
}

function parseGpart(text: string, dfText: string): PartScan {
  const { mountMap } = buildDfMap(dfText);
  const disks: DiskEntry[] = [];
  let curr: DiskEntry | null = null;

  for (const line of text.split("\n")) {
    const dh = line.match(/^=>\s+\d+\s+(\d+)\s+(\S+)\s+\S+\s+\(([^)]+)\)/);
    if (dh) {
      const sizeBytes = parsePartSizeBytes(dh[3]);
      curr = { name: dh[2], size: dh[3], sizeBytes, parts: [] };
      disks.push(curr);
      continue;
    }
    if (!curr) continue;
    const pm = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\(([^)]+)\)/);
    if (pm) {
      const sizeBytes = parsePartSizeBytes(pm[5]);
      const partName = pm[4];
      curr.parts.push({
        name: partName,
        label: null,
        size: pm[5],
        sizeBytes,
        sizePct: curr.sizeBytes > 0 ? sizeBytes / curr.sizeBytes : 0,
        fstype: null,
        mountpoint: mountMap[partName] ?? null,
        ro: false,
        slot: null,
      });
    }
  }
  return { disks, activeSlot: null, platform: "BSD", method: "gpart", switchCmd: null };
}

function parseDfFallback(dfText: string): PartScan {
  const seen = new Map<string, DiskEntry>();

  for (const line of dfText.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const rawDev = parts[0];
    if (!rawDev.startsWith("/dev/") && !rawDev.match(/^[a-z]+\d/)) continue;
    const devName = rawDev.replace(/^\/dev\//, "");
    const mount = parts[parts.length - 1];
    const sizeStr = parts[1] ?? "";
    const sm = sizeStr.match(/^(\d+(?:\.\d+)?)([KMGT])/i);
    const sizeBytes = sm ? parseSizeUnit(parseFloat(sm[1]), sm[2]) : 0;

    const diskName = devName.replace(/p?\d+$/, "").replace(/s\d+$/, "") || devName;

    if (!seen.has(diskName)) {
      seen.set(diskName, { name: diskName, size: "", sizeBytes: 0, parts: [] });
    }
    const disk = seen.get(diskName)!;
    if (devName === diskName) {
      disk.size = sizeStr;
      disk.sizeBytes = sizeBytes;
    } else {
      disk.parts.push({
        name: devName,
        label: null,
        size: sizeStr,
        sizeBytes,
        sizePct: 0,
        fstype: null,
        mountpoint: mount.startsWith("/") ? mount : null,
        ro: false,
        slot: null,
      });
    }
  }
  for (const disk of seen.values()) {
    if (disk.sizeBytes === 0) disk.sizeBytes = disk.parts.reduce((a, p) => a + p.sizeBytes, 0);
    for (const p of disk.parts) p.sizePct = disk.sizeBytes > 0 ? p.sizeBytes / disk.sizeBytes : 0;
  }
  const disks = Array.from(seen.values()).filter((d) => d.parts.length > 0 || d.sizeBytes > 0);
  return { disks, activeSlot: null, platform: "Unknown", method: "df", switchCmd: null };
}

function detectAbSwitch(cmdline: string, uboot: string, activeSlot: "a" | "b" | null): string | null {
  if (!activeSlot || uboot.includes("no-uboot")) return null;
  const next = activeSlot === "a" ? "b" : "a";
  return `fw_setenv slot_suffix _${next} && echo "Set active slot to ${next.toUpperCase()} — reboot to apply"`;
}

export function parsePartScan(raw: string): PartScan {
  const platform = partSec(raw, "PLATFORM").split("\n")[0].trim();

  if (platform === "Darwin") {
    return parseDiskutil(partSec(raw, "DISKUTIL"), partSec(raw, "DF"));
  }

  if (platform === "Linux") {
    const cmdline = partSec(raw, "CMDLINE");
    const uboot = partSec(raw, "UBOOT");
    let activeSlot: "a" | "b" | null = null;
    const am = cmdline.match(/androidboot\.slot_suffix=_([ab])/i) ?? cmdline.match(/\bslot_suffix=_([ab])/i);
    if (am) activeSlot = am[1].toLowerCase() as "a" | "b";
    if (!activeSlot && !uboot.includes("no-uboot")) {
      const um = uboot.match(/slot_suffix=_([ab])/i);
      if (um) activeSlot = um[1].toLowerCase() as "a" | "b";
    }
    const switchCmd = detectAbSwitch(cmdline, uboot, activeSlot);

    const lsblkRaw = partSec(raw, "LSBLK");
    if (lsblkRaw && lsblkRaw !== "null") {
      try {
        const r = parseLsblkJson(lsblkRaw, activeSlot);
        if (r.disks.length > 0) return { ...r, switchCmd };
      } catch {
        /* fall through */
      }
    }
    const r2 = parseProcPartitions(partSec(raw, "PROC_PARTS"), partSec(raw, "BLKID"), partSec(raw, "DF"), activeSlot);
    if (r2.disks.length > 0) return { ...r2, switchCmd };
    return { ...parseDfFallback(partSec(raw, "DF")), switchCmd };
  }

  const gpart = partSec(raw, "GPART");
  const df = partSec(raw, "DF");
  if (gpart) {
    const r = parseGpart(gpart, df);
    if (r.disks.length > 0) return r;
  }
  return parseDfFallback(df);
}

/** Partition index within a disk (sda1→1, nvme0n1p2→2, da0p3→3, disk0s2→2). */
export function partIndex(diskName: string, partName: string): number | null {
  const mac = partName.match(/^disk(\d+)s(\d+)$/i);
  if (mac) return parseInt(mac[2]);
  if (!partName.startsWith(diskName)) return null;
  const suffix = partName.slice(diskName.length);
  const m = suffix.match(/^p?(\d+)$/);
  return m ? parseInt(m[1]) : null;
}

export function devPath(name: string): string {
  return name.startsWith("/dev/") ? name : `/dev/${name}`;
}

export function freeSpaceBytes(disk: DiskEntry): number {
  const used = disk.parts.reduce((s, p) => s + p.sizeBytes, 0);
  return Math.max(0, disk.sizeBytes - used);
}

export function canManagePartitions(scan: PartScan): boolean {
  return scan.method !== "df" && scan.platform !== "Unknown";
}

export function isCriticalMount(mount: string | null): boolean {
  if (!mount) return false;
  return ["/", "/boot", "/boot/efi", "/usr", "/var", "/home"].includes(mount);
}

export const FORMAT_OPTIONS: Record<string, string[]> = {
  Linux: ["ext4", "xfs", "btrfs", "vfat", "swap"],
  macOS: ["apfs", "hfs+", "exfat", "msdos"],
  BSD: ["ufs", "zfs"],
};
