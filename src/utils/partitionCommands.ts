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

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}`;
}

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

function linuxResizeFs(fstype: string | null, dev: string): string {
  const fs = (fstype ?? "ext4").toLowerCase();
  if (fs === "xfs") return `xfs_growfs ${shQuote(dev.replace(/^\/dev\//, ""))} 2>/dev/null || xfs_growfs ${shQuote(dev)}`;
  if (fs === "btrfs") return `btrfs filesystem resize max ${shQuote(dev)}`;
  if (fs === "swap") return "true";
  return `resize2fs ${shQuote(dev)} 2>/dev/null || true`;
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

      if (platform === "Linux") {
        const endSpec = sizeMb > 0 ? `${sizeMb}MiB` : "100%";
        return {
          command: [
            `parted -s ${shQuote(diskDev)} unit MiB resizepart ${idx} ${endSpec}`,
            "partprobe " + shQuote(diskDev) + " 2>/dev/null || true",
            linuxResizeFs(part.fstype, dev),
            `echo "Resized partition ${idx} on ${diskDev}"`,
          ].join(" && "),
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
        const sizeSpec = sizeMb > 0 ? `${sizeMb}M` : "-a";
        return {
          command: [
            `gpart resize -i ${idx} -s ${sizeSpec} ${shQuote(assertDev(disk.name, "disk"))}`,
            `growfs ${shQuote(dev)} 2>/dev/null || true`,
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
        const mkfsSh = (() => {
          const fs = fstype.toLowerCase();
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
              return `mkfs.${fs} -F "$NEWDEV"`;
          }
        })();
        const mkpartLine =
          sizeMb > 0
            ? `parted -s "$DISK" unit MiB mkpart primary ${shQuote(fstype)} \${START}MiB $((START+${sizeMb}))MiB`
            : `parted -s "$DISK" unit MiB mkpart primary ${shQuote(fstype)} \${START}MiB 100%`;
        const script = [
          `DISK=${shQuote(diskDev)}`,
          `START=$(parted -s -m "$DISK" unit MiB print free 2>/dev/null | awk -F: '$5 ~ /free/ {print $2}' | tail -1)`,
          'if [ -z "$START" ] || [ "$START" = "0" ]; then echo "No free space found"; exit 1; fi',
          mkpartLine,
          'partprobe "$DISK" 2>/dev/null || true',
          'NEWPART=$(lsblk -ln -o NAME "$DISK" 2>/dev/null | grep -E "[0-9]$" | tail -1)',
          'if [ -z "$NEWPART" ]; then echo "Could not detect new partition"; exit 1; fi',
          'NEWDEV="/dev/$NEWPART"',
          mkfsSh,
          `echo "Created $NEWDEV formatted as ${fstype}"`,
        ].join("\n");
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
        const sizeSpec = sizeMb > 0 ? `${sizeMb}M` : "-a";
        return {
          command: [
            `gpart add -t freebsd-ufs -s ${sizeSpec} ${shQuote(assertDev(disk.name, "disk"))}`,
            'NEWPART=$(gpart show -p ' + shQuote(assertDev(disk.name, "disk")) + " | tail -1 | awk '{print $4}')",
            'newfs -U /dev/$NEWPART',
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
