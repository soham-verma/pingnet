import { test, expect } from "@playwright/test";
import { parsePartScan, partIndex, freeSpaceBytes, canManagePartitions, fmtPartBytes } from "../src/utils/partitions";
import { buildPartCommand, actionAvailable } from "../src/utils/partitionCommands";

test.describe("parsePartScan", () => {
  test("parses Linux lsblk JSON", () => {
    const raw = [
      "=== PLATFORM ===Linux",
      "=== LSBLK ===",
      JSON.stringify({
        blockdevices: [{
          name: "sda",
          size: "100G",
          type: "disk",
          children: [{
            name: "sda1",
            size: "50G",
            type: "part",
            fstype: "ext4",
            mountpoint: "/",
            ro: false,
          }],
        }],
      }),
      "=== PROC_PARTS ===",
      "=== BLKID ===",
      "=== DF ===",
      "=== CMDLINE ===",
      "=== UBOOT ===no-uboot",
    ].join("\n");
    const scan = parsePartScan(raw);
    expect(scan.platform).toBe("Linux");
    expect(scan.method).toBe("lsblk");
    expect(scan.disks).toHaveLength(1);
    expect(scan.disks[0].parts[0].fstype).toBe("ext4");
    expect(canManagePartitions(scan)).toBe(true);
  });

  test("parses macOS diskutil with df mounts", () => {
    const raw = [
      "=== PLATFORM ===Darwin",
      "=== DISKUTIL ===",
      "/dev/disk0 (internal, physical):",
      "   #:                       TYPE NAME                    SIZE       IDENTIFIER",
      "   0:      GUID_partition_scheme                        *500.0 GB   disk0",
      "   1:                        EFI EFI                     209.7 MB   disk0s1",
      "   2:                 Apple_APFS Container disk1         499.8 GB   disk0s2",
      "=== DF ===",
      "/dev/disk1s1  460Gi  200Gi  260Gi  44%  /",
    ].join("\n");
    const scan = parsePartScan(raw);
    expect(scan.platform).toBe("macOS");
    expect(scan.method).toBe("diskutil");
    expect(scan.disks[0].parts.some((p) => p.fstype === "apfs" || p.fstype === "vfat")).toBe(true);
  });

  test("df fallback is read-only", () => {
    const raw = "=== PLATFORM ===Unknown\n=== DF ===\n/dev/sda1  50G  10G  40G  20%  /data\n";
    const scan = parsePartScan(raw);
    expect(scan.method).toBe("df");
    expect(canManagePartitions(scan)).toBe(false);
  });
});

test.describe("partIndex", () => {
  test("linux and nvme suffixes", () => {
    expect(partIndex("sda", "sda1")).toBe(1);
    expect(partIndex("nvme0n1", "nvme0n1p2")).toBe(2);
  });
  test("macOS disk0s2", () => {
    expect(partIndex("disk0", "disk0s2")).toBe(2);
  });
});

test.describe("buildPartCommand", () => {
  const linuxScan = {
    disks: [],
    activeSlot: null,
    platform: "Linux",
    method: "lsblk",
    switchCmd: null,
  };
  const disk = {
    name: "sda",
    size: "100G",
    sizeBytes: 100e9,
    parts: [{
      name: "sda1",
      label: null,
      size: "50G",
      sizeBytes: 50e9,
      sizePct: 0.5,
      fstype: "ext4",
      mountpoint: "/data",
      ro: false,
      slot: null,
    }],
  };
  const part = disk.parts[0];

  test("mount requires mount point", () => {
    expect(() => buildPartCommand({
      action: "mount",
      scan: linuxScan,
      disk,
      part,
      mountPoint: "",
    })).toThrow();
  });

  test("builds Linux unmount", () => {
    const plan = buildPartCommand({ action: "unmount", scan: linuxScan, disk, part });
    expect(plan.command).toContain("umount");
    expect(plan.needsSudo).toBe(true);
  });

  test("builds Linux format as destructive", () => {
    const plan = buildPartCommand({ action: "format", scan: linuxScan, disk, part, fstype: "ext4" });
    expect(plan.destructive).toBe(true);
    expect(plan.command).toContain("mkfs.ext4");
  });

  test("builds Linux resize to max", () => {
    const plan = buildPartCommand({ action: "resize", scan: linuxScan, disk, part, sizeMb: 0 });
    expect(plan.command).toContain("resizepart");
    expect(plan.command).toContain("100%");
  });

  test("actionAvailable reflects mount state", () => {
    expect(actionAvailable("unmount", linuxScan, part)).toBe(true);
    expect(actionAvailable("mount", linuxScan, part)).toBe(false);
    const unmounted = { ...part, mountpoint: null };
    expect(actionAvailable("mount", linuxScan, unmounted)).toBe(true);
  });
});

test.describe("freeSpaceBytes", () => {
  test("computes unallocated space", () => {
    const disk = {
      name: "sda",
      size: "100G",
      sizeBytes: 100e9,
      parts: [{ name: "sda1", label: null, size: "40G", sizeBytes: 40e9, sizePct: 0.4, fstype: "ext4", mountpoint: null, ro: false, slot: null }],
    };
    expect(freeSpaceBytes(disk)).toBe(60e9);
    expect(fmtPartBytes(60e9)).toBe("60.0 GB");
  });
});
