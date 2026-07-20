import { useState, useEffect } from "react";
import { HostConfig, HostIp } from "../types";

const IP_TYPES: HostIp["type"][] = ["local", "wifi", "vpn", "public", "tailscale", "other"];
const IP_TYPE_LABELS: Record<HostIp["type"], string> = {
  local: "Local",
  wifi: "WiFi",
  vpn: "VPN",
  public: "Public",
  tailscale: "Tailscale",
  other: "Other",
};

interface Props {
  existing?: HostConfig | null;
  /** Pre-fills the IP/hostname field — used when adding a host from the Dashboard's connect bar */
  initialIp?: string;
  onSave: (data: Pick<HostConfig, "hostname" | "ip" | "ip_type" | "extra_ips" | "notes" | "alert_on_down" | "alert_on_recovery" | "alert_latency_ms">) => void;
  onClose: () => void;
  onDelete?: () => void;
}

export default function AddEditModal({ existing, initialIp, onSave, onClose, onDelete }: Props) {
  const [hostname, setHostname] = useState(existing?.hostname ?? "");
  const [ip, setIp] = useState(existing?.ip ?? initialIp ?? "");
  const [ipType, setIpType] = useState<HostIp["type"]>(existing?.ip_type ?? "local");
  const [extraIps, setExtraIps] = useState<HostIp[]>(existing?.extra_ips ?? []);
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [alertDown, setAlertDown] = useState(existing?.alert_on_down ?? false);
  const [alertRecovery, setAlertRecovery] = useState(existing?.alert_on_recovery ?? false);
  const [alertLatency, setAlertLatency] = useState<string>(
    existing?.alert_latency_ms != null ? String(existing.alert_latency_ms) : ""
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  // BUG-04 fix: use document (more reliable in WKWebView than window) and
  // also attach onKeyDown to the backdrop element as a belt-and-suspenders fallback.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // BUG-07 fix: proper IPv4 octet range check + RFC-1123 hostname check.
  // Removes the over-broad /^[\w.-]+$/ fallback that accepted 999.999.999.999.
  function isValidIp(addr: string): boolean {
    const parts = addr.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
  }

  function isValidHostname(h: string): boolean {
    if (h.length === 0 || h.length > 253) return false;
    // Each label: 1–63 chars of [A-Za-z0-9-], not starting/ending with hyphen
    const label = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
    return h.split(".").every((part) => label.test(part));
  }

  function validate() {
    const errs: Record<string, string> = {};
    if (!hostname.trim()) errs.hostname = "Name is required";
    const trimmedIp = ip.trim();
    if (!trimmedIp) {
      errs.ip = "IP or hostname is required";
    } else if (!isValidIp(trimmedIp) && !isValidHostname(trimmedIp)) {
      errs.ip = "Enter a valid IPv4 address or hostname";
    }
    if (alertLatency !== "" && (isNaN(Number(alertLatency)) || Number(alertLatency) <= 0)) {
      errs.alertLatency = "Enter a positive number (ms)";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validate()) {
      onSave({
        hostname: hostname.trim(),
        ip: ip.trim(),
        ip_type: ipType,
        extra_ips: extraIps.filter((e) => e.address.trim()),
        notes: notes.trim(),
        alert_on_down: alertDown,
        alert_on_recovery: alertRecovery,
        alert_latency_ms: alertLatency !== "" ? Number(alertLatency) : null,
      });
    }
  }

  // BUG-01 fix: confirm before deleting — one stray click can't destroy a host.
  function handleDeleteClick() {
    if (!onDelete) return;
    if (window.confirm(`Delete "${hostname || "this host"}"? This cannot be undone.`)) {
      onDelete();
    }
  }

  // BUG-11 fix: keyboard-accessible toggle — role="switch", tabIndex, Space/Enter support.
  const Toggle = ({
    checked,
    onChange,
    label,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
  }) => (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onClick={() => onChange(!checked)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onChange(!checked);
          }
        }}
        className={`relative w-9 h-5 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#6366f1] focus-visible:ring-offset-2 ${
          checked ? "bg-[#6366f1]" : "bg-[var(--border)]"
        }`}
        style={{ focusRingOffset: "var(--bg2)" } as React.CSSProperties}
      >
        <div
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
      <span className="text-sm text-[var(--text2)]">{label}</span>
    </label>
  );

  return (
    // BUG-04 fallback: onKeyDown on backdrop catches Escape even if document listener misses it
    <div
      className="fixed inset-0 z-50 flex items-start justify-center modal-backdrop overflow-y-auto py-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {/* BUG-03 fix: modal is now max-height capped and scrollable, matching KeyManager.
          Using flex-col so header stays fixed and only the form body scrolls. */}
      <div
        className="w-full max-w-md rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col my-auto"
        style={{ background: "var(--bg2)", maxHeight: "85vh" }}
      >
        {/* Header — fixed, never scrolls */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--border)] flex-shrink-0">
          <h2 className="font-semibold text-[var(--text)]">
            {existing ? "Edit Host" : "Add New Host"}
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--text3)] hover:text-[var(--text)] transition-colors text-xl"
          >
            ×
          </button>
        </div>

        {/* Scrollable form body */}
        <div className="overflow-y-auto flex-1">
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
            {/* Display Name */}
            <div>
              <label className="block text-[11px] tracking-widest text-[var(--text3)] uppercase mb-2">
                Display Name
              </label>
              <input
                type="text"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder="e.g. Home NAS, VPS Sydney"
                className={`w-full px-4 py-2.5 rounded-lg bg-[var(--bg)] border text-sm text-[var(--text)] placeholder-[var(--text5)] outline-none transition-all focus:border-[#6366f1] ${
                  errors.hostname ? "border-[#ef4444]" : "border-[var(--border)]"
                }`}
                autoFocus
              />
              {errors.hostname && (
                <p className="text-[#ef4444] text-xs mt-1">{errors.hostname}</p>
              )}
            </div>

            {/* IP Addresses */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-[11px] tracking-widest text-[var(--text3)] uppercase">
                  IP Addresses
                </label>
              </div>

              {/* Primary IP */}
              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={ip}
                  onChange={(e) => setIp(e.target.value)}
                  placeholder="e.g. 192.168.1.10 or example.com"
                  className={`flex-1 min-w-0 px-3 py-2.5 rounded-lg bg-[var(--bg)] border text-sm text-[var(--text)] placeholder-[var(--text5)] font-mono outline-none transition-all focus:border-[#6366f1] ${
                    errors.ip ? "border-[#ef4444]" : "border-[var(--border)]"
                  }`}
                />
                <select
                  value={ipType}
                  onChange={(e) => setIpType(e.target.value as HostIp["type"])}
                  className="px-2 py-2.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text3)] outline-none focus:border-[#6366f1] transition-all"
                >
                  {IP_TYPES.map((t) => (
                    <option key={t} value={t}>{IP_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              {errors.ip && <p className="text-[#ef4444] text-xs mb-2">{errors.ip}</p>}

              {/* Extra IPs */}
              {extraIps.map((eip, idx) => (
                <div key={idx} className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={eip.address}
                    onChange={(e) => {
                      const next = [...extraIps];
                      next[idx] = { ...next[idx], address: e.target.value };
                      setExtraIps(next);
                    }}
                    placeholder="e.g. 10.0.0.1"
                    className="flex-1 min-w-0 px-3 py-2.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text)] placeholder-[var(--text5)] font-mono outline-none transition-all focus:border-[#6366f1]"
                  />
                  <select
                    value={eip.type}
                    onChange={(e) => {
                      const next = [...extraIps];
                      next[idx] = { ...next[idx], type: e.target.value as HostIp["type"] };
                      setExtraIps(next);
                    }}
                    className="px-2 py-2.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text3)] outline-none focus:border-[#6366f1] transition-all"
                  >
                    {IP_TYPES.map((t) => (
                      <option key={t} value={t}>{IP_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setExtraIps(extraIps.filter((_, i) => i !== idx))}
                    className="w-9 flex-shrink-0 flex items-center justify-center rounded-lg text-[var(--text4)] hover:text-[#ef4444] hover:bg-[#ef444415] border border-transparent hover:border-[#ef444430] transition-all"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={() => setExtraIps([...extraIps, { address: "", type: "local" }])}
                className="flex items-center gap-1.5 text-[11px] text-[var(--text3)] hover:text-[#6366f1] transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                Add another IP
              </button>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-[11px] tracking-widest text-[var(--text3)] uppercase mb-2">
                Notes <span className="text-[var(--text5)] normal-case tracking-normal">(optional)</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Home server rack, AP Southeast-2"
                rows={2}
                className="w-full px-4 py-2.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-sm text-[var(--text)] placeholder-[var(--text5)] outline-none transition-all focus:border-[#6366f1] resize-none"
              />
            </div>

            {/* ── Alert Settings ─────────────────────────────────────────────── */}
            <div className="border border-[var(--border)] rounded-xl p-4 space-y-3">
              <p className="text-[11px] tracking-widest text-[var(--text3)] uppercase">Alerts</p>
              <Toggle
                checked={alertDown}
                onChange={setAlertDown}
                label="Notify when host goes down"
              />
              <Toggle
                checked={alertRecovery}
                onChange={setAlertRecovery}
                label="Notify when host recovers"
              />
              <div>
                <label className="text-sm text-[var(--text2)]">
                  Latency spike threshold (ms){" "}
                  <span className="text-[var(--text3)] text-xs">(optional)</span>
                </label>
                <input
                  type="number"
                  min={1}
                  value={alertLatency}
                  onChange={(e) => setAlertLatency(e.target.value)}
                  placeholder="e.g. 200"
                  className={`mt-1.5 w-full px-4 py-2 rounded-lg bg-[var(--bg)] border text-sm text-[var(--text)] placeholder-[var(--text5)] font-mono outline-none transition-all focus:border-[#6366f1] ${
                    errors.alertLatency ? "border-[#ef4444]" : "border-[var(--border)]"
                  }`}
                />
                {errors.alertLatency && (
                  <p className="text-[#ef4444] text-xs mt-1">{errors.alertLatency}</p>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              {existing && onDelete && (
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  className="px-4 py-2 rounded-lg text-sm text-[#ef4444] hover:bg-[#ef444410] border border-[#ef444430] hover:border-[#ef4444] transition-all"
                >
                  Delete
                </button>
              )}
              <div className="flex-1" />
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm text-[var(--text3)] hover:text-[var(--text)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-lg text-sm font-medium text-[var(--text)] bg-[#6366f1] hover:bg-[#818cf8] transition-colors"
              >
                {existing ? "Save Changes" : "Add Host"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
