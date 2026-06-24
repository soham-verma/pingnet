import { useState, useEffect } from "react";
import { HostConfig } from "../types";

interface Props {
  existing?: HostConfig | null;
  onSave: (data: Pick<HostConfig, "hostname" | "ip" | "notes" | "alert_on_down" | "alert_on_recovery" | "alert_latency_ms">) => void;
  onClose: () => void;
  onDelete?: () => void;
}

export default function AddEditModal({ existing, onSave, onClose, onDelete }: Props) {
  const [hostname, setHostname] = useState(existing?.hostname ?? "");
  const [ip, setIp] = useState(existing?.ip ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [alertDown, setAlertDown] = useState(existing?.alert_on_down ?? false);
  const [alertRecovery, setAlertRecovery] = useState(existing?.alert_on_recovery ?? false);
  const [alertLatency, setAlertLatency] = useState<string>(
    existing?.alert_latency_ms != null ? String(existing.alert_latency_ms) : ""
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  function validate() {
    const errs: Record<string, string> = {};
    if (!hostname.trim()) errs.hostname = "Name is required";
    if (!ip.trim()) errs.ip = "IP or hostname is required";
    const ipPattern =
      /^(\d{1,3}\.){3}\d{1,3}$|^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
    if (ip.trim() && !ipPattern.test(ip.trim()) && !/^[\w.-]+$/.test(ip.trim())) {
      errs.ip = "Enter a valid IP address or hostname";
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
        notes: notes.trim(),
        alert_on_down: alertDown,
        alert_on_recovery: alertRecovery,
        alert_latency_ms: alertLatency !== "" ? Number(alertLatency) : null,
      });
    }
  }

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
      <div
        className={`relative w-9 h-5 rounded-full transition-colors ${checked ? "bg-[#6366f1]" : "bg-[#1e1e35]"}`}
        onClick={() => onChange(!checked)}
      >
        <div
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </div>
      <span className="text-sm text-[#9ca3af]">{label}</span>
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[#1e1e35] shadow-2xl"
        style={{ background: "#0f0f1a" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[#1e1e35]">
          <h2 className="font-semibold text-white">
            {existing ? "Edit Host" : "Add New Host"}
          </h2>
          <button
            onClick={onClose}
            className="text-[#4b5563] hover:text-white transition-colors text-xl"
          >
            ×
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Display Name */}
          <div>
            <label className="block text-[11px] tracking-widest text-[#4b5563] uppercase mb-2">
              Display Name
            </label>
            <input
              type="text"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="e.g. Home NAS, VPS Sydney"
              className={`w-full px-4 py-2.5 rounded-lg bg-[#080810] border text-sm text-white placeholder-[#2d3748] outline-none transition-all focus:border-[#6366f1] ${
                errors.hostname ? "border-[#ef4444]" : "border-[#1e1e35]"
              }`}
              autoFocus
            />
            {errors.hostname && (
              <p className="text-[#ef4444] text-xs mt-1">{errors.hostname}</p>
            )}
          </div>

          {/* IP */}
          <div>
            <label className="block text-[11px] tracking-widest text-[#4b5563] uppercase mb-2">
              IP Address / Hostname
            </label>
            <input
              type="text"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="e.g. 192.168.1.10 or example.com"
              className={`w-full px-4 py-2.5 rounded-lg bg-[#080810] border text-sm text-white placeholder-[#2d3748] font-mono outline-none transition-all focus:border-[#6366f1] ${
                errors.ip ? "border-[#ef4444]" : "border-[#1e1e35]"
              }`}
            />
            {errors.ip && (
              <p className="text-[#ef4444] text-xs mt-1">{errors.ip}</p>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-[11px] tracking-widest text-[#4b5563] uppercase mb-2">
              Notes <span className="text-[#2d3748] normal-case tracking-normal">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Home server rack, AP Southeast-2"
              rows={2}
              className="w-full px-4 py-2.5 rounded-lg bg-[#080810] border border-[#1e1e35] text-sm text-white placeholder-[#2d3748] outline-none transition-all focus:border-[#6366f1] resize-none"
            />
          </div>

          {/* ── Alert Settings ─────────────────────────────────────────────── */}
          <div className="border border-[#1e1e35] rounded-xl p-4 space-y-3">
            <p className="text-[11px] tracking-widest text-[#4b5563] uppercase">Alerts</p>
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
              <label className="text-sm text-[#9ca3af]">
                Latency spike threshold (ms){" "}
                <span className="text-[#4b5563] text-xs">(optional)</span>
              </label>
              <input
                type="number"
                min={1}
                value={alertLatency}
                onChange={(e) => setAlertLatency(e.target.value)}
                placeholder="e.g. 200"
                className={`mt-1.5 w-full px-4 py-2 rounded-lg bg-[#080810] border text-sm text-white placeholder-[#2d3748] font-mono outline-none transition-all focus:border-[#6366f1] ${
                  errors.alertLatency ? "border-[#ef4444]" : "border-[#1e1e35]"
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
                onClick={onDelete}
                className="px-4 py-2 rounded-lg text-sm text-[#ef4444] hover:bg-[#ef444410] border border-[#ef444430] hover:border-[#ef4444] transition-all"
              >
                Delete
              </button>
            )}
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-[#4b5563] hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-lg text-sm font-medium text-white bg-[#6366f1] hover:bg-[#818cf8] transition-colors"
            >
              {existing ? "Save Changes" : "Add Host"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
