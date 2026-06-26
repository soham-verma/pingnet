import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  PART_SCAN_SCRIPT,
  parsePartScan,
  partFsColor,
  fmtPartBytes,
  freeSpaceBytes,
  canManagePartitions,
  FORMAT_OPTIONS,
  devPath,
  type DiskEntry,
  type PartEntry,
  type PartScan,
} from "../../utils/partitions";
import {
  buildPartCommand,
  actionAvailable,
  type PartAction,
  type PartCommandPlan,
} from "../../utils/partitionCommands";

interface Props {
  sessionId: string;
}

interface PendingChange {
  id: string;
  plan: PartCommandPlan;
}

type ModalState =
  | { kind: "none" }
  | { kind: "queue"; action: PartAction; plan: PartCommandPlan }
  | { kind: "apply" }
  | { kind: "ab-switch"; target: "a" | "b"; plan: PartCommandPlan };

function ConfirmCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-start gap-2.5 text-[11px] text-[var(--text2)] cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 flex-shrink-0"
      />
      <span>{label}</span>
    </label>
  );
}

async function remoteExec(sessionId: string, command: string, sudoPassword: string | null, needsSudo: boolean) {
  return invoke<string>("ssh_exec", {
    sessionId,
    command,
    sudoPassword: needsSudo ? sudoPassword : null,
  });
}

function ActionBtn({
  label,
  enabled,
  danger,
  onClick,
}: {
  label: string;
  enabled: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={onClick}
      className="px-2.5 py-1 rounded text-[10px] font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
      style={{
        background: danger ? "#ef444418" : "#6366f115",
        color: danger ? "#f87171" : "#818cf8",
        border: `1px solid ${danger ? "#ef444430" : "#6366f130"}`,
      }}
    >
      {label}
    </button>
  );
}

function PartDiskBar({
  disk,
  activeSlot,
  selectedPart,
  onSelect,
}: {
  disk: DiskEntry;
  activeSlot: "a" | "b" | null;
  selectedPart: string | null;
  onSelect: (name: string | null) => void;
}) {
  const total = disk.parts.reduce((s, p) => s + p.sizeBytes, 0) || disk.sizeBytes || 1;
  const free = freeSpaceBytes(disk);
  const selPart = disk.parts.find((p) => p.name === selectedPart);

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="font-mono text-[11px] text-[var(--text2)]">{devPath(disk.name)}</span>
        <span className="text-[10px] text-[var(--text4)]">{disk.size || fmtPartBytes(disk.sizeBytes)}</span>
        {free > 0 && (
          <span className="text-[9px] text-[var(--text5)]">{fmtPartBytes(free)} free</span>
        )}
        {disk.parts.some((p) => p.slot) && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: "#00c8a815", color: "#00c8a8" }}>
            A/B · active {activeSlot?.toUpperCase() ?? "?"}
          </span>
        )}
      </div>

      <div className="flex h-9 rounded-lg overflow-hidden border border-[var(--border)] gap-px bg-[var(--border)]">
        {disk.parts.length === 0 ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="flex-1 flex items-center justify-center bg-[var(--bg)] text-[10px] text-[var(--text4)] hover:bg-white/[0.03]"
          >
            {disk.sizeBytes > 0 ? `${fmtPartBytes(disk.sizeBytes)} · unallocated` : "Empty disk — create partition"}
          </button>
        ) : (
          disk.parts.map((p) => {
            const pct = Math.max(2, (p.sizeBytes / total) * 100);
            const color = partFsColor(p.fstype, p.slot);
            const isSel = selectedPart === p.name;
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => onSelect(isSel ? null : p.name)}
                title={`${p.name}  ${p.size}  ${p.fstype ?? "raw"}${p.mountpoint ? `  ${p.mountpoint}` : ""}`}
                className="flex flex-col items-center justify-center transition-all relative overflow-hidden"
                style={{
                  width: `${pct}%`,
                  background: isSel ? color : `${color}88`,
                  outline: isSel ? `2px solid ${color}` : "none",
                  outlineOffset: "-2px",
                }}
              >
                {pct > 10 && (
                  <span className="font-mono text-[8px] font-bold text-white/80 px-0.5 truncate max-w-full">
                    {p.name.replace(/^.*\//, "")}
                  </span>
                )}
                {pct > 14 && p.fstype && <span className="text-[7px] text-white/60">{p.fstype}</span>}
              </button>
            );
          })
        )}
      </div>

      {selPart && (
        <div
          className="mt-2 grid grid-cols-3 gap-2 rounded-lg p-2.5 border text-[10px]"
          style={{
            background: `${partFsColor(selPart.fstype, selPart.slot)}08`,
            borderColor: `${partFsColor(selPart.fstype, selPart.slot)}30`,
          }}
        >
          {[
            ["Name", selPart.name],
            ["Size", selPart.size],
            ["FS", selPart.fstype ?? "—"],
            ["Mount", selPart.mountpoint ?? "—"],
            ["Label", selPart.label ?? "—"],
            ["Flags", selPart.ro ? "ro" : "rw"],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="text-[9px] text-[var(--text4)] uppercase tracking-wider mb-0.5">{k}</div>
              <div className="font-mono text-[var(--text)] truncate">{v}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PartitionManager({ sessionId }: Props) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [scan, setScan] = useState<PartScan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedDisk, setSelectedDisk] = useState<string | null>(null);
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const [sudoPassword, setSudoPassword] = useState("");
  const [showSudo, setShowSudo] = useState(false);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [confirmUnderstand, setConfirmUnderstand] = useState(false);
  const [confirmBackup, setConfirmBackup] = useState(false);

  // Action form fields
  const [fstype, setFstype] = useState("ext4");
  const [label, setLabel] = useState("");
  const [mountPoint, setMountPoint] = useState("/mnt/data");
  const [sizeMb, setSizeMb] = useState("");
  const [growMax, setGrowMax] = useState(true);

  const hasPending = pending.length > 0;
  const hasDestructivePending = pending.some((p) => p.plan.destructive);

  const doScan = useCallback(async (force = false) => {
    if (!force && hasPending) {
      const ok = window.confirm("Discard pending partition changes and rescan?");
      if (!ok) return;
      setPending([]);
    }
    setState("loading");
    setErr(null);
    try {
      const raw = await invoke<string>("ssh_exec", { sessionId, command: PART_SCAN_SCRIPT, sudoPassword: null });
      const parsed = parsePartScan(raw);
      setScan(parsed);
      if (parsed.disks.length > 0 && !selectedDisk) setSelectedDisk(parsed.disks[0].name);
      setState("done");
    } catch (e) {
      setErr(String(e));
      setState("error");
    }
  }, [sessionId, selectedDisk, hasPending]);

  const activeDisk = scan?.disks.find((d) => d.name === selectedDisk) ?? scan?.disks[0] ?? null;
  const activePart = activeDisk?.parts.find((p) => p.name === selectedPart) ?? null;
  const fmtOptions = scan ? (FORMAT_OPTIONS[scan.platform] ?? FORMAT_OPTIONS.Linux) : FORMAT_OPTIONS.Linux;
  const manageable = scan ? canManagePartitions(scan) : false;

  const openAction = (action: PartAction) => {
    if (!scan || !activeDisk) return;
    try {
      const size = growMax && action !== "mount" && action !== "unmount" ? 0 : parseInt(sizeMb, 10) || 0;
      const plan = buildPartCommand({
        action,
        scan,
        disk: activeDisk,
        part: activePart ?? undefined,
        fstype,
        label: label.trim() || undefined,
        mountPoint: mountPoint.trim(),
        sizeMb: size,
      });
      setModal({ kind: "queue", action, plan });
    } catch (e) {
      setLastOutput(String(e));
    }
  };

  const queuePlan = (plan: PartCommandPlan) => {
    setPending((prev) => [...prev, { id: crypto.randomUUID(), plan }]);
    setModal({ kind: "none" });
    setLastOutput(`Queued: ${plan.summary} (not applied yet)`);
  };

  const removePending = (id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  };

  const clearPending = () => setPending([]);

  const openApplyModal = () => {
    setConfirmUnderstand(false);
    setConfirmBackup(false);
    setModal({ kind: "apply" });
  };

  const applyPending = async () => {
    if (!confirmUnderstand || !confirmBackup || pending.length === 0) return;
    setBusy(true);
    setLastOutput(null);
    const pw = sudoPassword.trim() || null;
    const lines: string[] = [];

    try {
      for (let i = 0; i < pending.length; i++) {
        const { plan } = pending[i];
        if (plan.needsSudo && !pw) {
          setShowSudo(true);
          throw new Error(`Sudo password required (step ${i + 1}: ${plan.summary})`);
        }
        lines.push(`▶ ${plan.summary}`);
        const out = await remoteExec(sessionId, plan.command, pw, plan.needsSudo);
        if (out.trim()) lines.push(out.trim());
      }
      setLastOutput(lines.join("\n\n") || "All changes applied.");
      setPending([]);
      setModal({ kind: "none" });
      setConfirmUnderstand(false);
      setConfirmBackup(false);
      await doScan(true);
    } catch (e) {
      setLastOutput([...lines, `✗ ${String(e)}`].join("\n\n"));
    } finally {
      setBusy(false);
    }
  };

  const queueAbSwitch = (target: "a" | "b") => {
    if (!scan?.switchCmd) return;
    const plan: PartCommandPlan = {
      command: scan.switchCmd,
      summary: `Switch A/B boot slot to ${target.toUpperCase()}`,
      destructive: true,
      needsSudo: true,
      warnings: ["Takes effect on next reboot"],
    };
    setModal({ kind: "ab-switch", target, plan });
  };

  const applyReady = confirmUnderstand && confirmBackup;

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: "var(--bg1)", border: "1px solid var(--border)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Partitions</span>
          {scan && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: "var(--bg2)", color: "var(--text4)" }}>
              {scan.platform} · {scan.method}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSudo((s) => !s)}
            className="text-[10px] px-2 py-1 rounded transition-colors"
            style={{ color: sudoPassword ? "#00c8a8" : "var(--text4)", border: "1px solid var(--border)" }}
          >
            {sudoPassword ? "Sudo ✓" : "Sudo"}
          </button>
          {state === "idle" ? (
            <button
              type="button"
              onClick={() => void doScan()}
              className="text-[10px] px-2 py-1 rounded font-medium"
              style={{ background: "#6366f115", color: "#818cf8", border: "1px solid #6366f130" }}
            >
              Scan
            </button>
          ) : (
            <button type="button" onClick={() => void doScan()} className="text-[10px] text-[var(--text4)] hover:text-[var(--text3)]">
              ↻ Rescan
            </button>
          )}
        </div>
      </div>

      {showSudo && (
        <div className="px-4 py-2 border-b border-[var(--border)] flex items-center gap-2" style={{ background: "var(--bg)" }}>
          <span className="text-[10px] text-[var(--text4)] flex-shrink-0">Sudo password</span>
          <input
            type="password"
            value={sudoPassword}
            onChange={(e) => setSudoPassword(e.target.value)}
            placeholder="Required for mount/format/resize…"
            className="flex-1 px-2 py-1 rounded text-[11px] font-mono bg-[var(--bg1)] border border-[var(--border)] text-[var(--text)] outline-none focus:border-[#6366f1]"
          />
        </div>
      )}

      <div className="px-4 py-3 space-y-3">
        {state === "idle" && (
          <p className="text-[11px] text-[var(--text5)] italic text-center py-2">
            Scan disks to view layout and manage partitions (Linux, macOS, BSD)
          </p>
        )}
        {state === "loading" && (
          <div className="flex items-center justify-center gap-2 py-4">
            <span className="w-4 h-4 rounded-full border-2 border-[#6366f1] border-t-transparent animate-spin" />
            <span className="text-[11px] text-[var(--text4)]">Scanning…</span>
          </div>
        )}
        {state === "error" && <p className="text-[11px] text-[#ef4444] text-center py-2">{err}</p>}

        {state === "done" && scan && (
          <>
            {!manageable && (
              <p className="text-[10px] text-[#f59e0b] bg-[#f59e0b10] border border-[#f59e0b30] rounded-lg px-3 py-2">
                Read-only view — full management requires lsblk, diskutil, or gpart. Mount/unmount may still work via device paths.
              </p>
            )}

            {scan.switchCmd && scan.activeSlot && (
              <div className="flex items-center gap-2 flex-wrap rounded-lg px-3 py-2 border border-[#00c8a830]" style={{ background: "#00c8a808" }}>
                <span className="text-[10px] text-[#00c8a8]">A/B boot · active {scan.activeSlot.toUpperCase()}</span>
                <button
                  type="button"
                  onClick={() => queueAbSwitch(scan.activeSlot === "a" ? "b" : "a")}
                  className="ml-auto text-[10px] px-2 py-1 rounded font-medium"
                  style={{ background: "#f59e0b18", color: "#f59e0b", border: "1px solid #f59e0b30" }}
                >
                  Switch to {scan.activeSlot === "a" ? "B" : "A"}
                </button>
              </div>
            )}

            {(scan.disks.length ?? 0) > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {scan.disks.map((d) => (
                  <button
                    key={d.name}
                    type="button"
                    onClick={() => {
                      setSelectedDisk(d.name);
                      setSelectedPart(null);
                    }}
                    className="px-2.5 py-1 rounded-lg text-[10px] font-mono transition-all"
                    style={
                      activeDisk?.name === d.name
                        ? { background: "#6366f1", color: "#fff" }
                        : { background: "var(--bg)", color: "var(--text3)", border: "1px solid var(--border)" }
                    }
                  >
                    {devPath(d.name)}
                  </button>
                ))}
              </div>
            )}

            {scan.disks.length === 0 ? (
              <p className="text-[11px] text-[var(--text5)] italic text-center py-2">No disks detected</p>
            ) : (
              activeDisk && (
                <PartDiskBar
                  disk={activeDisk}
                  activeSlot={scan.activeSlot}
                  selectedPart={selectedPart}
                  onSelect={setSelectedPart}
                />
              )
            )}

            {/* Action toolbar */}
            {manageable && activeDisk && (
              <div className="rounded-lg border border-[var(--border)] p-3 space-y-3" style={{ background: "var(--bg)" }}>
                <p className="text-[9px] tracking-widest text-[var(--text5)] uppercase">Actions — queued until you apply</p>
                <div className="flex flex-wrap gap-1.5">
                  <ActionBtn label="Mount" enabled={actionAvailable("mount", scan, activePart ?? undefined)} onClick={() => openAction("mount")} />
                  <ActionBtn label="Unmount" enabled={actionAvailable("unmount", scan, activePart ?? undefined)} onClick={() => openAction("unmount")} />
                  <ActionBtn label="Format" enabled={actionAvailable("format", scan, activePart ?? undefined)} danger onClick={() => openAction("format")} />
                  <ActionBtn label="Resize" enabled={actionAvailable("resize", scan, activePart ?? undefined)} onClick={() => openAction("resize")} />
                  <ActionBtn label="Delete" enabled={actionAvailable("delete", scan, activePart ?? undefined)} danger onClick={() => openAction("delete")} />
                  <ActionBtn label="New partition" enabled={actionAvailable("create", scan)} onClick={() => openAction("create")} />
                </div>

                {/* Shared form fields */}
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-[var(--border)]">
                  <label className="text-[10px] text-[var(--text4)]">
                    Filesystem
                    <select
                      value={fstype}
                      onChange={(e) => setFstype(e.target.value)}
                      className="mt-1 w-full px-2 py-1 rounded text-[11px] bg-[var(--bg1)] border border-[var(--border)] text-[var(--text)]"
                    >
                      {fmtOptions.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[10px] text-[var(--text4)]">
                    Label (optional)
                    <input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      className="mt-1 w-full px-2 py-1 rounded text-[11px] font-mono bg-[var(--bg1)] border border-[var(--border)] text-[var(--text)]"
                    />
                  </label>
                  <label className="text-[10px] text-[var(--text4)] col-span-2">
                    Mount point (for Mount)
                    <input
                      value={mountPoint}
                      onChange={(e) => setMountPoint(e.target.value)}
                      placeholder="/mnt/data"
                      className="mt-1 w-full px-2 py-1 rounded text-[11px] font-mono bg-[var(--bg1)] border border-[var(--border)] text-[var(--text)]"
                    />
                  </label>
                  <label className="text-[10px] text-[var(--text4)]">
                    Size (MB)
                    <input
                      value={sizeMb}
                      onChange={(e) => setSizeMb(e.target.value)}
                      placeholder="2048"
                      className="mt-1 w-full px-2 py-1 rounded text-[11px] font-mono bg-[var(--bg1)] border border-[var(--border)] text-[var(--text)]"
                    />
                  </label>
                  <label className="text-[10px] text-[var(--text4)] flex items-end gap-2 pb-1">
                    <input type="checkbox" checked={growMax} onChange={(e) => setGrowMax(e.target.checked)} />
                    Use all free space (resize/create)
                  </label>
                </div>
              </div>
            )}

            {/* Pending operations (GParted-style) */}
            {hasPending && (
              <div
                className="rounded-lg border p-3 space-y-2"
                style={{ background: "#f59e0b08", borderColor: "#f59e0b40" }}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] tracking-widest uppercase font-semibold" style={{ color: "#f59e0b" }}>
                    Pending changes ({pending.length}) — not applied yet
                  </p>
                  <button
                    type="button"
                    onClick={clearPending}
                    className="text-[10px] text-[var(--text4)] hover:text-[var(--text2)]"
                  >
                    Discard all
                  </button>
                </div>
                <ol className="space-y-1.5">
                  {pending.map((item, i) => (
                    <li
                      key={item.id}
                      className="flex items-start gap-2 rounded-lg px-2.5 py-2 border border-[var(--border)]"
                      style={{ background: "var(--bg1)" }}
                    >
                      <span className="text-[10px] font-mono text-[var(--text5)] mt-0.5">{i + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] text-[var(--text)]">{item.plan.summary}</p>
                        {item.plan.destructive && (
                          <span className="text-[9px] text-[#ef4444]">destructive</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => removePending(item.id)}
                        className="text-[10px] text-[var(--text4)] hover:text-[#ef4444] flex-shrink-0"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ol>
                <button
                  type="button"
                  onClick={openApplyModal}
                  disabled={busy}
                  className="w-full py-2.5 rounded-xl text-[12px] font-semibold transition-all disabled:opacity-40"
                  style={{ background: hasDestructivePending ? "#ef4444" : "#6366f1", color: "#fff" }}
                >
                  Apply {pending.length} change{pending.length !== 1 ? "s" : ""}…
                </button>
              </div>
            )}

            {lastOutput && (
              <pre className="text-[10px] font-mono text-[var(--text3)] bg-[var(--bg)] border border-[var(--border)] rounded-lg p-3 whitespace-pre-wrap max-h-32 overflow-y-auto">
                {lastOutput}
              </pre>
            )}
          </>
        )}
      </div>

      {/* Queue action modal — adds to pending, does not run */}
      {modal.kind === "queue" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-md rounded-2xl border border-[var(--border)] p-5" style={{ background: "var(--bg2)" }}>
            <h3 className="font-semibold text-[var(--text)] mb-1">Queue change</h3>
            <p className="text-[11px] text-[var(--text3)] mb-2">
              This will <strong>not</strong> run until you apply pending changes and confirm both checkboxes.
            </p>
            <p className="text-[12px] text-[var(--text)] mb-2">{modal.plan.summary}</p>
            {modal.plan.warnings.map((w) => (
              <p key={w} className="text-[11px] text-[#f59e0b] mb-1">⚠ {w}</p>
            ))}
            <pre className="font-mono text-[10px] text-[var(--text3)] bg-[var(--bg)] rounded-lg p-3 my-3 border border-[var(--border)] whitespace-pre-wrap max-h-40 overflow-y-auto">
              {modal.plan.command}
            </pre>
            <div className="flex gap-2">
              <button type="button" onClick={() => setModal({ kind: "none" })} className="flex-1 py-2 rounded-xl text-sm border border-[var(--border)] text-[var(--text3)]">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => queuePlan(modal.plan)}
                className="flex-1 py-2 rounded-xl text-sm font-semibold"
                style={{ background: modal.plan.destructive ? "#f59e0b" : "#6366f1", color: "#fff" }}
              >
                Add to pending
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Apply modal — requires two confirmation checkboxes */}
      {modal.kind === "apply" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-md rounded-2xl border border-[var(--border)] p-5" style={{ background: "var(--bg2)" }}>
            <h3 className="font-semibold text-[var(--text)] mb-1">Apply partition changes</h3>
            <p className="text-[11px] text-[var(--text3)] mb-3">
              {pending.length} operation{pending.length !== 1 ? "s" : ""} will run on the remote host. This cannot be undone.
            </p>
            <ol className="text-[11px] text-[var(--text2)] space-y-1 mb-4 max-h-32 overflow-y-auto">
              {pending.map((item, i) => (
                <li key={item.id}>{i + 1}. {item.plan.summary}</li>
              ))}
            </ol>
            <div className="space-y-3 mb-4 rounded-lg border border-[var(--border)] p-3" style={{ background: "var(--bg)" }}>
              <ConfirmCheckbox
                checked={confirmUnderstand}
                onChange={setConfirmUnderstand}
                label="I understand these operations will modify disk partitions on the remote device."
              />
              <ConfirmCheckbox
                checked={confirmBackup}
                onChange={setConfirmBackup}
                label="I have verified backups and accept the risk of permanent data loss."
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setModal({ kind: "none" }); setConfirmUnderstand(false); setConfirmBackup(false); }}
                className="flex-1 py-2 rounded-xl text-sm border border-[var(--border)] text-[var(--text3)]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !applyReady}
                onClick={applyPending}
                className="flex-1 py-2 rounded-xl text-sm font-semibold disabled:opacity-40"
                style={{ background: hasDestructivePending ? "#ef4444" : "#6366f1", color: "#fff" }}
              >
                {busy ? "Applying…" : "Apply changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal.kind === "ab-switch" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] p-5" style={{ background: "var(--bg2)" }}>
            <h3 className="font-semibold text-[var(--text)] mb-2">Queue A/B slot switch to {modal.target.toUpperCase()}?</h3>
            <p className="text-[11px] text-[var(--text3)] mb-3">Takes effect on next reboot. Added to pending — not applied yet.</p>
            <pre className="font-mono text-[10px] text-[var(--text3)] bg-[var(--bg)] rounded-lg p-3 mb-4 border border-[var(--border)]">{modal.plan.command}</pre>
            <div className="flex gap-2">
              <button type="button" onClick={() => setModal({ kind: "none" })} className="flex-1 py-2 rounded-xl text-sm border border-[var(--border)]">Cancel</button>
              <button
                type="button"
                onClick={() => queuePlan(modal.plan)}
                className="flex-1 py-2 rounded-xl text-sm font-semibold"
                style={{ background: "#f59e0b", color: "#000" }}
              >
                Add to pending
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
