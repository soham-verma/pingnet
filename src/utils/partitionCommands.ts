import {
  devPath,
  freeSpaceBytes,
  isCriticalMount,
  partIndex,
  type DiskEntry,
  type PartEntry,
  type PartScan,
} from "./partitions";

export type PartAction = "mount" | "unmount" | "format" | "resize" | "delete" | "create";

export interface PartActionParams {
  action: PartAction;
  scan: PartScan;
  disk: DiskEntry;
  part?: PartEntry;
  fstype?: string;
  label?: string;
  mountPoint?: string;
  /** New size in MB (resize) or partition size (create). Use 0 for "max". */
  sizeMb?: number;
}

export interface PartCommandPlan {
  command: string;
  summary: string;
  destructive: boolean;
  needsSudo: boolean;
  warnings: string[];
}

const DEV_RE = /^[a-zA-Z0-9._-]+$/;
const MOUNT_RE = /^\/[a-zA-Z0-9/_.@-]*$/;

function assertDev(name: string, label: string): string {
  const base = name.replace(/^\/dev\//, "");
  if (!base || base.length > 64 || !DEV_RE.test(base)) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
  return base;
}

/** POSIX single-quote a value for safe embedding in a shell command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const MIB = 1024 * 1024;

function linuxMkfs(fstype: string, dev: string): string {
  const fs = fstype.toLowerCase();
  switch (fs) {
    case "ext4":
    case "ext3":
    case "ext2":
      return `mkfs.${fs} -F ${shQuote(dev)}`;
    case "xfs":
      return `mkfs.xfs -f ${shQuote(dev)}`;
    case "btrfs":
      return `mkfs.btrfs -f ${shQuote(dev)}`;
    case "vfat":
    case "fat32":
      return `mkfs.vfat -F 32 ${shQuote(dev)}`;
    case "swap":
      return `mkswap ${shQuote(dev)}`;
    default:
      throw new Error(`Unsupported filesystem on Linux: ${fstype}`);
  }
}

function macFormatType(fstype: string): string {
  switch (fstype.toLowerCase()) {
    case "apfs":
      return "APFS";
    case "hfs+":
    case "hfs":
      return "JHFS+";
    case "exfat":
      return "ExFAT";
    case "msdos":
    case "vfat":
    case "fat32":
      return "MS-DOS";
    default:
      throw new Error(`Unsupported filesystem on macOS: ${fstype}`);
  }
}

/**
 * Filesystem-grow step run AFTER the partition has been enlarged.
 * Failures are NOT suppressed — the script runs under `set -eu`.
 * xfs/btrfs can only grow while mounted; ext2/3/4 grow online or offline.
 */
function linuxGrowFs(fstype: string | null): string[] {
  const fs = (fstype ?? "").toLowerCase();
  switch (fs) {
    case "ext2":
    case "ext3":
    case "ext4":
      return ['resize2fs "$DEV"'];
    case "xfs":
      return ['xfs_growfs "$MP"'];
    case "btrfs":
      return ['btrfs filesystem resize max "$MP"'];
    case "":
      return ['echo "No filesystem detected — partition resized only"'];
    default:
      throw new Error(`Growing a ${fstype} filesystem isn't supported — resize the partition manually`);
  }
}

/**
 * Linux resize — GROW ONLY. `parted resizepart` takes the partition's new END
 * offset (not a size), so the end is computed on the device from the
 * partition's current start. Shrinking needs fs-first ordering and is
 * interactive in parted; it's refused here rather than done unsafely.
 */
function linuxResizeScript(diskDev: string, dev: string, idx: number, fstype: string | null, sizeMb: number): string {
  const fs = (fstype ?? "").toLowerCase();
  const needsMount = fs === "xfs" || fs === "btrfs";
  return [
    "set -eu",
    `DISK=${shQuote(diskDev)}`,
    `DEV=${shQuote(dev)}`,
    `IDX=${idx}`,
    // Current start/end of this partition, integer MiB (parted -m prints e.g. "1024MiB")
    `LINE=$(parted -s -m "$DISK" unit MiB print | awk -F: -v n="$IDX" '$1==n {print $2" "$3}')`,
    'if [ -z "$LINE" ]; then echo "Partition $IDX not found on $DISK"; exit 1; fi',
    `START=$(echo "$LINE" | awk '{s=$1; sub(/MiB/,"",s); printf "%d", s}')`,
    `CUR_END=$(echo "$LINE" | awk '{e=$2; sub(/MiB/,"",e); printf "%d", e}')`,
    ...(needsMount
      ? [
          'MP=$(findmnt -nro TARGET --source "$DEV" 2>/dev/null | head -n1 || true)',
          `if [ -z "$MP" ]; then echo "${fs} can only grow while mounted — mount $DEV first"; exit 1; fi`,
        ]
      : []),
    ...(sizeMb > 0
      ? [
          `NEW_END=$((START + ${Math.floor(sizeMb)}))`,
          'if [ "$NEW_END" -lt "$CUR_END" ]; then echo "Shrinking is not supported (current end ${CUR_END}MiB, requested ${NEW_END}MiB)"; exit 1; fi',
          'if [ "$NEW_END" -eq "$CUR_END" ]; then echo "Partition is already that size"; exit 0; fi',
          'parted -s "$DISK" unit MiB resizepart "$IDX" "${NEW_END}MiB"',
        ]
      : ['parted -s "$DISK" unit MiB resizepart "$IDX" 100%']),
    'partprobe "$DISK" 2>/dev/null || true',
    ...linuxGrowFs(fstype),
    'echo "Resized partition $IDX on $DISK"',
  ].join("\n");
}

/**
 * Linux create. Fails closed at every step: aborts if parted fails, and only
 * formats a partition that did not exist before mkpart AND is the single new
 * entry — never "the last partition in the list".
 */
function linuxCreateScript(diskDev: string, fstype: string, sizeMb: number): string {
  const fs = fstype.toLowerCase();
  const mkfs = (() => {
    switch (fs) {
      case "ext4":
      case "ext3":
      case "ext2":
        return `mkfs.${fs} -F "$NEWDEV"`;
      case "xfs":
        return 'mkfs.xfs -f "$NEWDEV"';
      case "btrfs":
        return 'mkfs.btrfs -f "$NEWDEV"';
      case "vfat":
      case "fat32":
        return 'mkfs.vfat -F 32 "$NEWDEV"';
      case "swap":
        return 'mkswap "$NEWDEV"';
      default:
        throw new Error(`Unsupported filesystem on Linux: ${fstype}`);
    }
  })();
  const partedFs = fs === "swap" ? "linux-swap" : fs === "vfat" ? "fat32" : fs;
  return [
    "set -eu",
    `DISK=${shQuote(diskDev)}`,
    'BEFORE=$(mktemp)',
    'trap \'rm -f "$BEFORE"\' EXIT',
    // Partitions that exist before we touch anything
    `lsblk -lnpo NAME,TYPE "$DISK" | awk '$2=="part"{print $1}' | sort > "$BEFORE"`,
    // Largest free region, integer MiB: "<start> <end>"
    `FREE=$(parted -s -m "$DISK" unit MiB print free | awk -F: '$5 ~ /free/ {s=$2; e=$3; z=$4; sub(/MiB/,"",s); sub(/MiB/,"",e); sub(/MiB/,"",z); if (z+0 > best) {best=z+0; bs=s; be=e}} END {if (best >= 1) printf "%d %d", bs + 0.999, be}')`,
    'if [ -z "$FREE" ]; then echo "No free space found on $DISK"; exit 1; fi',
    `START=$(echo "$FREE" | awk '{print $1}')`,
    `FREE_END=$(echo "$FREE" | awk '{print $2}')`,
    ...(sizeMb > 0
      ? [
          `END=$((START + ${Math.floor(sizeMb)}))`,
          'if [ "$END" -gt "$FREE_END" ]; then echo "Not enough free space: $((FREE_END - START)) MiB available"; exit 1; fi',
          `parted -s "$DISK" unit MiB mkpart primary ${shQuote(partedFs)} "\${START}MiB" "\${END}MiB"`,
        ]
      : [`parted -s "$DISK" unit MiB mkpart primary ${shQuote(partedFs)} "\${START}MiB" "\${FREE_END}MiB"`]),
    'partprobe "$DISK" 2>/dev/null || true',
    'udevadm settle 2>/dev/null || sleep 1',
    // Exactly one partition must have appeared
    `NEW=$(lsblk -lnpo NAME,TYPE "$DISK" | awk '$2=="part"{print $1}' | sort | comm -13 "$BEFORE" -)`,
    'COUNT=$(printf "%s\\n" "$NEW" | grep -c . || true)',
    'if [ "$COUNT" -ne 1 ]; then echo "Could not identify the new partition (found $COUNT new entries) — nothing was formatted"; exit 1; fi',
    'NEWDEV="$NEW"',
    'if grep -q "^$NEWDEV " /proc/mounts; then echo "$NEWDEV is mounted — refusing to format"; exit 1; fi',
    mkfs,
    `echo "Created $NEWDEV formatted as ${fs}"`,
  ].join("\n");
}

export function buildPartCommand(params: PartActionParams): PartCommandPlan {
  const { action, scan, disk, part } = params;
  const platform = scan.platform;
  const diskDev = devPath(assertDev(disk.name, "disk"));
  const warnings: string[] = [];

  if (part?.mountpoint && isCriticalMount(part.mountpoint)) {
    warnings.push(`Partition is mounted at critical path ${part.mountpoint}`);
  }

  switch (action) {
    case "mount": {
      if (!part) throw new Error("Select a partition to mount");
      const dev = devPath(assertDev(part.name, "partition"));
      if (platform === "Linux" || platform === "BSD") {
        const mp = params.mountPoint?.trim();
        if (!mp || !MOUNT_RE.test(mp)) throw new Error("Enter a valid absolute mount path (e.g. /mnt/data)");
        return {
          command: `mkdir -p ${shQuote(mp)} && mount ${shQuote(dev)} ${shQuote(mp)} && echo "Mounted ${dev} at ${mp}"`,
          summary: `Mount ${dev} at ${mp}`,
          destructive: false,
          needsSudo: true,
          warnings,
        };
      }
      if (platform === "macOS") {
        const id = assertDev(part.name, "partition");
        return {
          command: `diskutil mount ${shQuote(id)} && echo "Mounted ${id}"`,
          summary: `Mount ${id}`,
          destructive: false,
          needsSudo: false,
          warnings,
        };
      }
      throw new Error(`Mount not supported on ${platform}`);
    }

    case "unmount": {
      if (!part) throw new Error("Select a partition to unmount");
      const dev = devPath(assertDev(part.name, "partition"));
      if (platform === "Linux" || platform === "BSD") {
        return {
          command: `umount ${shQuote(dev)} && echo "Unmounted ${dev}"`,
          summary: `Unmount ${dev}`,
          destructive: false,
          needsSudo: true,
          warnings,
        };
      }
      if (platform === "macOS") {
        const id = assertDev(part.name, "partition");
        return {
          command: `diskutil unmount ${shQuote(id)} && echo "Unmounted ${id}"`,
          summary: `Unmount ${id}`,
          destructive: false,
          needsSudo: false,
          warnings,
        };
      }
      throw new Error(`Unmount not supported on ${platform}`);
    }

    case "format": {
      if (!part) throw new Error("Select a partition to format");
      const fstype = params.fstype?.trim();
      if (!fstype) throw new Error("Choose a filesystem type");
      const dev = devPath(assertDev(part.name, "partition"));
      warnings.push("All data on this partition will be permanently erased");

      if (platform === "Linux") {
        return {
          command: [
            `umount ${shQuote(dev)} 2>/dev/null || true`,
            linuxMkfs(fstype, dev),
            params.label ? `e2label ${shQuote(dev)} ${shQuote(params.label)} 2>/dev/null || true` : "",
            `echo "Formatted ${dev} as ${fstype}"`,
          ].filter(Boolean).join(" && "),
          summary: `Format ${dev} as ${fstype}`,
          destructive: true,
          needsSudo: true,
          warnings,
        };
      }
      if (platform === "macOS") {
        const id = assertDev(part.name, "partition");
        const fmt = macFormatType(fstype);
        const volLabel = params.label?.trim() || "Untitled";
        return {
          command: `diskutil eraseVolume ${fmt} ${shQuote(volLabel)} ${shQuote(id)} && echo "Formatted ${id}"`,
          summary: `Format ${id} as ${fmt}`,
          destructive: true,
          needsSudo: false,
          warnings,
        };
      }
      if (platform === "BSD") {
        if (fstype.toLowerCase() !== "ufs") throw new Error("BSD format currently supports ufs only");
        return {
          command: [
            `umount ${shQuote(dev)} 2>/dev/null || true`,
            `newfs -U ${shQuote(dev)}`,
            `echo "Formatted ${dev} as UFS"`,
          ].join(" && "),
          summary: `Format ${dev} as UFS`,
          destructive: true,
          needsSudo: true,
          warnings,
        };
      }
      throw new Error(`Format not supported on ${platform}`);
    }

    case "resize": {
      if (!part) throw new Error("Select a partition to resize");
      const idx = partIndex(disk.name, part.name);
      if (idx === null) throw new Error("Could not determine partition number");
      const dev = devPath(assertDev(part.name, "partition"));
      const sizeMb = params.sizeMb ?? 0;

      // diskutil shrinks APFS/HFS+ safely; parted/gpart paths here only grow
      if (platform !== "macOS" && sizeMb > 0 && part.sizeBytes > 0 && sizeMb * MIB < part.sizeBytes - MIB) {
        throw new Error("Shrinking partitions isn't supported — only growing. Shrink offline with a dedicated tool.");
      }

      if (platform === "Linux") {
        return {
          command: linuxResizeScript(diskDev, dev, idx, part.fstype, sizeMb),
          summary: sizeMb > 0 ? `Resize ${dev} to ${sizeMb} MiB` : `Grow ${dev} to fill free space`,
          destructive: true,
          needsSudo: true,
          warnings: [...warnings, "Ensure a backup exists before resizing"],
        };
      }
      if (platform === "macOS") {
        const id = assertDev(part.name, "partition");
        if (sizeMb <= 0) throw new Error("Enter target size in MB for macOS resize");
        const sizeSpec = sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(1)}g` : `${sizeMb}m`;
        return {
          command: `diskutil resizeVolume ${shQuote(id)} ${sizeSpec} && echo "Resized ${id}"`,
          summary: `Resize ${id} to ${sizeSpec}`,
          destructive: true,
          needsSudo: false,
          warnings: [...warnings, "Ensure a backup exists before resizing"],
        };
      }
      if (platform === "BSD") {
        const sizeSpec = `${sizeMb}M`;
        return {
          command: [
            `gpart resize -i ${idx} ${sizeMb > 0 ? `-s ${sizeSpec} ` : ""}${shQuote(assertDev(disk.name, "disk"))}`,
            `growfs -y ${shQuote(dev)}`,
            `echo "Resized ${dev}"`,
          ].join(" && "),
          summary: `Resize ${dev}`,
          destructive: true,
          needsSudo: true,
          warnings: [...warnings, "Ensure a backup exists before resizing"],
        };
      }
      throw new Error(`Resize not supported on ${platform}`);
    }

    case "delete": {
      if (!part) throw new Error("Select a partition to delete");
      const idx = partIndex(disk.name, part.name);
      warnings.push("Partition will be removed from the partition table");

      if (platform === "Linux") {
        if (idx === null) throw new Error("Could not determine partition number");
        const dev = devPath(assertDev(part.name, "partition"));
        return {
          command: [
            `umount ${shQuote(dev)} 2>/dev/null || true`,
            `parted -s ${shQuote(diskDev)} rm ${idx}`,
            "partprobe " + shQuote(diskDev) + " 2>/dev/null || true",
            `echo "Deleted partition ${idx} from ${diskDev}"`,
          ].join(" && "),
          summary: `Delete ${dev} (partition ${idx})`,
          destructive: true,
          needsSudo: true,
          warnings,
        };
      }
      if (platform === "macOS") {
        const id = assertDev(part.name, "partition");
        return {
          command: `diskutil eraseVolume free none ${shQuote(id)} && echo "Deleted ${id}"`,
          summary: `Delete volume ${id}`,
          destructive: true,
          needsSudo: false,
          warnings,
        };
      }
      if (platform === "BSD") {
        if (idx === null) throw new Error("Could not determine partition index");
        return {
          command: [
            `gpart delete -i ${idx} ${shQuote(assertDev(disk.name, "disk"))}`,
            `echo "Deleted partition ${idx}"`,
          ].join(" && "),
          summary: `Delete partition ${idx} on ${disk.name}`,
          destructive: true,
          needsSudo: true,
          warnings,
        };
      }
      throw new Error(`Delete not supported on ${platform}`);
    }

    case "create": {
      const fstype = params.fstype?.trim() || "ext4";
      const sizeMb = params.sizeMb ?? 0;
      const freeMb = Math.floor(freeSpaceBytes(disk) / (1024 * 1024));
      if (freeMb < 64 && sizeMb === 0) throw new Error("Not enough free space on disk");

      if (platform === "Linux") {
        const script = linuxCreateScript(diskDev, fstype, sizeMb);
        return {
          command: script,
          summary: sizeMb > 0 ? `Create ${sizeMb} MiB ${fstype} partition` : `Create partition using all free space (${freeMb} MiB)`,
          destructive: true,
          needsSudo: true,
          warnings: ["Creates a new partition in unallocated space"],
        };
      }
      if (platform === "macOS") {
        throw new Error("Creating partitions on macOS requires repartitioning the whole disk — use Disk Utility on the host");
      }
      if (platform === "BSD") {
        const sizeSpec = `${sizeMb}M`;
        return {
          command: [
            "set -eu",
            // gpart prints "<name> added" — use exactly that, never "the last row"
            `NEWPART=$(gpart add -t freebsd-ufs ${sizeMb > 0 ? `-s ${sizeSpec} ` : ""}${shQuote(assertDev(disk.name, "disk"))} | awk '/ added/{print $1}')`,
            'if [ -z "$NEWPART" ]; then echo "Could not identify the new partition — nothing was formatted"; exit 1; fi',
            'newfs -U "/dev/$NEWPART"',
            'echo "Created /dev/$NEWPART"',
          ].join("\n"),
          summary: `Create UFS partition (${sizeMb > 0 ? `${sizeMb}M` : "all free"})`,
          destructive: true,
          needsSudo: true,
          warnings: ["Creates a new partition in unallocated space"],
        };
      }
      throw new Error(`Create not supported on ${platform}`);
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

export function actionAvailable(action: PartAction, scan: PartScan, part?: PartEntry): boolean {
  if (!canManageAction(scan)) return false;
  const p = scan.platform;

  switch (action) {
    case "mount":
      return !!part && !part.mountpoint;
    case "unmount":
      return !!part && !!part.mountpoint;
    case "format":
      return !!part;
    case "resize":
      return !!part && p !== "Unknown";
    case "delete":
      return !!part;
    case "create":
      return p === "Linux" || p === "BSD";
    default:
      return false;
  }
}

function canManageAction(scan: PartScan): boolean {
  return scan.method !== "df" && scan.platform !== "Unknown";
}
