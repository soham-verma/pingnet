/**
 * Execution-level tests for generated partition scripts.
 *  - every generated command must parse under `sh -n`
 *  - Linux create/resize scripts are RUN against stub parted/lsblk/mkfs
 *    binaries (never a real disk) to prove they fail closed.
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPartCommand, shQuote, type PartAction } from "../src/utils/partitionCommands";
import type { DiskEntry, PartEntry, PartScan } from "../src/utils/partitions";

test.skip(process.platform === "win32", "POSIX shell required");

const part: PartEntry = {
  name: "sda2", label: null, size: "2G", sizeBytes: 2048 * 1024 * 1024, sizePct: 10,
  fstype: "ext4", mountpoint: null, ro: false, slot: null,
};
const disk: DiskEntry = { name: "sda", size: "20G", sizeBytes: 20480 * 1024 * 1024, parts: [part] };
const scanFor = (platform: string): PartScan =>
  ({ disks: [disk], activeSlot: null, platform, method: platform === "Linux" ? "lsblk" : "diskutil", switchCmd: null } as PartScan);

test("shQuote closes its quote and escapes embedded quotes", () => {
  expect(shQuote("sda1")).toBe("'sda1'");
  const out = execFileSync("sh", ["-c", `printf %s ${shQuote("it's $HOME `x`")}`]).toString();
  expect(out).toBe("it's $HOME `x`");
});

test("every generated command parses under sh -n", () => {
  const actions: PartAction[] = ["mount", "unmount", "format", "resize", "delete", "create"];
  let checked = 0;
  for (const platform of ["Linux", "macOS", "BSD"]) {
    for (const action of actions) {
      for (const sizeMb of [0, 4096]) {
        let plan;
        try {
          plan = buildPartCommand({
            action, scan: scanFor(platform), disk, part, sizeMb, mountPoint: "/mnt/da'ta",
            fstype: platform === "macOS" ? "apfs" : platform === "BSD" ? "ufs" : "ext4", label: "my 'label'",
          });
        } catch { continue; } // unsupported combination
        const r = spawnSync("sh", ["-n", "-c", plan.command]);
        expect(r.status, `${platform}/${action}/${sizeMb}: ${r.stderr}`).toBe(0);
        // The UI wraps plans in sh -c '<plan>' — that must parse too
        const wrapped = spawnSync("sh", ["-n", "-c", `sh -c ${shQuote(plan.command)}`]);
        expect(wrapped.status).toBe(0);
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(20);
});

test("resize refuses to shrink on Linux", () => {
  expect(() => buildPartCommand({ action: "resize", scan: scanFor("Linux"), disk, part, sizeMb: 1024 }))
    .toThrow(/Shrinking/);
});

// ── Stub harness ─────────────────────────────────────────────────────────────

interface Harness { dir: string; run: (script: string) => { status: number | null; out: string }; log: (n: string) => string }

function harness(opts: { mkpartFails?: boolean; twoNew?: boolean; resize2fsFails?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pn-stub-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  if (opts.mkpartFails) writeFileSync(join(dir, "mkpart_fail"), "");
  if (opts.twoNew) writeFileSync(join(dir, "two_new"), "");
  if (opts.resize2fsFails) writeFileSync(join(dir, "resize2fs_fail"), "");
  const S = dir;
  stub("parted", `
echo "$@" >> "${S}/parted.log"
case "$*" in
  *mkpart*) [ -e "${S}/mkpart_fail" ] && { echo "Error: mkpart failed" >&2; exit 1; }; touch "${S}/created" ;;
  *resizepart*) : ;;
  *"print free"*)
    printf 'BYT;\\n/dev/sda:20480MiB:scsi:512:512:gpt:Disk:;\\n1:0.02MiB:1.00MiB:0.98MiB:free;\\n1:1.00MiB:1024MiB:1023MiB:ext4::;\\n2:1024MiB:3072MiB:2048MiB:ext4::;\\n1:3072MiB:20480MiB:17408MiB:free;\\n' ;;
  *print*)
    printf 'BYT;\\n/dev/sda:20480MiB:scsi:512:512:gpt:Disk:;\\n1:1.00MiB:1024MiB:1023MiB:ext4::;\\n2:1024MiB:3072MiB:2048MiB:ext4::;\\n' ;;
esac`);
  stub("lsblk", `
echo "/dev/sda disk"; echo "/dev/sda1 part"; echo "/dev/sda2 part"
if [ -e "${S}/created" ]; then echo "/dev/sda3 part"; [ -e "${S}/two_new" ] && echo "/dev/sda4 part"; fi
exit 0`);
  stub("partprobe", "exit 0");
  stub("udevadm", "exit 0");
  stub("findmnt", "exit 1");
  for (const m of ["mkfs.ext4", "mkfs.xfs", "mkswap"]) stub(m, `echo "${m} $@" >> "${S}/mkfs.log"`);
  stub("resize2fs", `echo "resize2fs $@" >> "${S}/fs.log"; [ -e "${S}/resize2fs_fail" ] && exit 1; exit 0`);
  return {
    dir,
    run: (script) => {
      const r = spawnSync("sh", ["-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    log: (n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), "utf8") : ""),
  };
}

const createPlan = (sizeMb: number) =>
  buildPartCommand({ action: "create", scan: scanFor("Linux"), disk, fstype: "ext4", sizeMb }).command;
const resizePlan = (sizeMb: number) =>
  buildPartCommand({ action: "resize", scan: scanFor("Linux"), disk, part, sizeMb }).command;

test("create: formats exactly the new partition in the largest free region", () => {
  const h = harness();
  const r = h.run(createPlan(4096));
  expect(r.status, r.out).toBe(0);
  expect(h.log("parted.log")).toContain("mkpart primary ext4 3072MiB 7168MiB");
  expect(h.log("mkfs.log").trim()).toBe("mkfs.ext4 -F /dev/sda3");
});

for (const size of [4096, 0]) {
  test(`create: mkpart failure aborts before any formatter runs (size ${size || "max"})`, () => {
    const h = harness({ mkpartFails: true });
    const r = h.run(createPlan(size));
    expect(r.status).not.toBe(0);
    expect(h.log("mkfs.log")).toBe(""); // BUG-002: old script formatted the existing /dev/sda2 here
  });
}

test("create: ambiguous result (two new partitions) formats nothing", () => {
  const h = harness({ twoNew: true });
  const r = h.run(createPlan(0));
  expect(r.status).not.toBe(0);
  expect(r.out).toContain("nothing was formatted");
  expect(h.log("mkfs.log")).toBe("");
});

test("create: request larger than free space aborts before mkpart", () => {
  const h = harness();
  const r = h.run(createPlan(999999));
  expect(r.status).not.toBe(0);
  expect(h.log("parted.log")).not.toContain("mkpart");
});

test("resize: end offset = partition start + requested size, then fs grow", () => {
  const h = harness();
  const r = h.run(resizePlan(4096));
  expect(r.status, r.out).toBe(0);
  expect(h.log("parted.log")).toContain('resizepart 2 5120MiB');
  expect(h.log("fs.log")).toContain("resize2fs /dev/sda2");
});

test("resize: runtime shrink is refused before touching the table", () => {
  const h = harness();
  // plan-time guard passes (sizeBytes lies low), device says partition is 2048 MiB
  const small = { ...part, sizeBytes: 512 * 1024 * 1024 };
  const cmd = buildPartCommand({ action: "resize", scan: scanFor("Linux"), disk, part: small, sizeMb: 1024 }).command;
  const r = h.run(cmd);
  expect(r.status).not.toBe(0);
  expect(h.log("parted.log")).not.toContain("resizepart");
});

test("resize: filesystem grow failure is reported, not swallowed", () => {
  const h = harness({ resize2fsFails: true });
  const r = h.run(resizePlan(4096));
  expect(r.status).not.toBe(0);
});
