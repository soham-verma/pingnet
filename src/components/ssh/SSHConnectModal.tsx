import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { SshConfig, KeyInfo } from "../../types";

interface Props {
  hostname: string;
  ip: string;
  savedConfig: SshConfig | null;
  onConnect: (config: SshConfig, password: string) => void;
  onClose: () => void;
}

/** Returns seconds remaining in the current 30-second TOTP window */
function totpSecondsLeft(): number {
  return 30 - (Math.floor(Date.now() / 1000) % 30);
}

export default function SSHConnectModal({ hostname, ip, savedConfig, onConnect, onClose }: Props) {
  const [port, setPort] = useState(savedConfig?.port ?? 22);
  const [username, setUsername] = useState(savedConfig?.username ?? "");
  const [authType, setAuthType] = useState<"password" | "key" | "keychain" | "agent" | "totp">(
    (savedConfig?.auth_type as "password" | "key" | "keychain" | "agent" | "totp") ?? "password"
  );
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState(savedConfig?.key_path ?? "~/.ssh/id_ed25519");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // BUG-08 / BUG-09: inline validation errors shown when the user clicks Connect
  // with an empty username, port 0, or an incomplete TOTP code.
  const [connectError, setConnectError] = useState<string | null>(null);

  // TOTP state
  const [totpCode, setTotpCode] = useState("");
  const [totpSecsLeft, setTotpSecsLeft] = useState(totpSecondsLeft());
  const totpTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (authType !== "totp") return;
    setTotpSecsLeft(totpSecondsLeft());
    totpTimerRef.current = setInterval(() => {
      const s = totpSecondsLeft();
      setTotpSecsLeft(s);
      // Warn user when the window is about to expire
      if (s === 30) setTotpCode(""); // clear stale code on new window
    }, 1000);
    return () => { if (totpTimerRef.current) clearInterval(totpTimerRef.current); };
  }, [authType]);

  // Keychain key picker
  const [keychainKeys, setKeychainKeys] = useState<KeyInfo[]>([]);
  const [keychainError, setKeychainError] = useState<string | null>(null);
  const [selectedKeyName, setSelectedKeyName] = useState<string>(savedConfig?.key_name ?? "");

  useEffect(() => {
    if (authType === "keychain") {
      setKeychainError(null);
      invoke<KeyInfo[]>("list_ssh_keys")
        .then((keys) => { setKeychainKeys(keys); })
        .catch((e) => {
          setKeychainKeys([]);
          setKeychainError(String(e));
        });
    }
  }, [authType]);

  const handleConnect = () => {
    // BUG-08 fix: surface a clear error instead of silently no-op-ing.
    // BUG-09 fix: validate port range before passing to backend.
    setConnectError(null);
    if (!username.trim()) {
      setConnectError("Username is required.");
      return;
    }
    if (port < 1 || port > 65535 || !Number.isInteger(port)) {
      setConnectError("Port must be between 1 and 65535.");
      return;
    }
    if (authType === "totp" && totpCode.trim().length < 6) {
      setConnectError("Enter the full 6-digit TOTP code.");
      return;
    }
    if (authType === "keychain" && !selectedKeyName) {
      setConnectError("Select a key from the list.");
      return;
    }
    const config: SshConfig = {
      port,
      username: username.trim(),
      auth_type: authType,
      key_path: authType === "key" ? keyPath : undefined,
      key_name: authType === "keychain" ? selectedKeyName : undefined,
    };
    // For TOTP, the code is passed as the "password" field — SSHSessionView
    // will wrap it into SshAuth::KbdInt { totp_code } on the Rust side.
    onConnect(
      config,
      authType === "password" ? password
      : authType === "key"      ? keyPassphrase
      : authType === "totp"     ? totpCode.trim()
      : ""
    );
  };

  const inputCls =
    "w-full bg-[var(--bg1)] border border-[var(--border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text)] placeholder-[var(--text4)] focus:outline-none focus:border-[#6366f1] transition-colors font-mono";
  const labelCls = "block text-[11px] text-[var(--text3)] tracking-widest uppercase mb-1.5";

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="w-full max-w-md rounded-2xl border border-[var(--border)] overflow-hidden"
        style={{ background: "var(--bg2)" }}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-[var(--border)]" style={{ background: "var(--bg1)" }}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[var(--text)] font-semibold text-base">Connect via SSH</h2>
              <p className="text-[var(--text3)] text-[12px] mt-0.5 font-mono">{hostname} · {ip}</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Host / port */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Address</label>
              <input className={inputCls} value={ip} readOnly style={{ opacity: 0.6 }} />
            </div>
            <div>
              <label className={labelCls}>Port</label>
              <input
                className={inputCls}
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </div>
          </div>

          {/* Username */}
          <div>
            <label className={labelCls}>Username</label>
            <input
              className={inputCls}
              placeholder="root"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </div>

          {/* Auth type tabs */}
          <div>
            <label className={labelCls}>Authentication</label>
            <div className="flex gap-1 p-1 rounded-lg" style={{ background: "var(--bg1)" }}>
              {(["password", "agent", "key", "keychain", "totp"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setAuthType(t)}
                  className="flex-1 py-2 rounded-md text-[12px] font-medium transition-all"
                  style={
                    authType === t
                      ? { background: "#6366f1", color: "#fff" }
                      : { color: "var(--text3)" }
                  }
                >
                  {t === "password" ? "Password" : t === "agent" ? "Agent" : t === "key" ? "Key File" : t === "keychain" ? "Keychain" : "TOTP"}
                </button>
              ))}
            </div>
          </div>

          {/* Auth fields */}
          {authType === "password" && (
            <div>
              <label className={labelCls}>Password</label>
              <div className="relative">
                <input
                  className={inputCls}
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text3)] hover:text-[var(--text)] text-[11px]"
                >
                  {showPassword ? "hide" : "show"}
                </button>
              </div>
            </div>
          )}

          {authType === "key" && (
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Key file</label>
                <div className="flex gap-2">
                  <input
                    className={inputCls + " flex-1 min-w-0"}
                    placeholder="~/.ssh/id_ed25519"
                    value={keyPath}
                    onChange={(e) => setKeyPath(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const selected = await openDialog({
                        title: "Select SSH private key",
                        multiple: false,
                        directory: false,
                      });
                      if (typeof selected === "string") setKeyPath(selected);
                    }}
                    className="flex-shrink-0 px-3 py-2 rounded-lg border border-[var(--border)] text-[11px] text-[var(--text3)] hover:text-[var(--text)] hover:border-[#6366f1] transition-colors"
                  >
                    Browse
                  </button>
                </div>
                {/* Quick-pick common key types */}
                <div className="flex gap-1.5 mt-2">
                  {[
                    { label: "ed25519", path: "~/.ssh/id_ed25519" },
                    { label: "rsa",     path: "~/.ssh/id_rsa"     },
                    { label: "ecdsa",   path: "~/.ssh/id_ecdsa"   },
                  ].map(({ label, path }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setKeyPath(path)}
                      className="px-2 py-0.5 rounded text-[11px] font-mono border transition-colors"
                      style={
                        keyPath === path
                          ? { background: "#6366f1", color: "#fff", borderColor: "#6366f1" }
                          : { background: "var(--bg1)", color: "var(--text3)", borderColor: "var(--border)" }
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className={labelCls}>Passphrase (if encrypted)</label>
                <div className="relative">
                  <input
                    className={inputCls}
                    type={showPassphrase ? "text" : "password"}
                    placeholder="Leave empty if none"
                    value={keyPassphrase}
                    onChange={(e) => setKeyPassphrase(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassphrase(!showPassphrase)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text3)] hover:text-[var(--text)] text-[11px]"
                  >
                    {showPassphrase ? "hide" : "show"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {authType === "agent" && (
            <div className="rounded-lg border border-[var(--border)] px-4 py-3 space-y-1" style={{ background: "var(--bg1)" }}>
              <p className="text-[11px] text-[var(--text3)]">
                Connects using your running SSH agent (<span className="font-mono">SSH_AUTH_SOCK</span>).
                Any key already loaded in the agent will be tried automatically — same as how your terminal works.
              </p>
            </div>
          )}

          {authType === "keychain" && (
            <div>
              <label className={labelCls}>Select managed key</label>
              {keychainError ? (
                <p className="text-[#ef4444] text-xs py-2 font-mono">
                  {keychainError}
                </p>
              ) : keychainKeys.length === 0 ? (
                <p className="text-[var(--text3)] text-xs py-2">
                  No keys in keychain. Open the Key Manager to generate one.
                </p>
              ) : (
                <select
                  className={inputCls}
                  value={selectedKeyName}
                  onChange={(e) => setSelectedKeyName(e.target.value)}
                >
                  <option value="">— Select a key —</option>
                  {keychainKeys.map((k) => (
                    <option key={k.name} value={k.name}>
                      {k.name}{k.comment ? ` (${k.comment})` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {authType === "totp" && (
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className={labelCls} style={{ margin: 0 }}>Verification code</label>
                  {/* Countdown ring */}
                  <div className="flex items-center gap-1.5">
                    <span
                      className="text-[11px] font-mono font-semibold tabular-nums"
                      style={{ color: totpSecsLeft <= 5 ? "#ef4444" : totpSecsLeft <= 10 ? "#f59e0b" : "var(--text3)" }}
                    >
                      {totpSecsLeft}s
                    </span>
                    <svg width="16" height="16" viewBox="0 0 16 16">
                      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--border)" strokeWidth="2" />
                      <circle
                        cx="8" cy="8" r="6" fill="none"
                        stroke={totpSecsLeft <= 5 ? "#ef4444" : totpSecsLeft <= 10 ? "#f59e0b" : "#6366f1"}
                        strokeWidth="2"
                        strokeDasharray={`${(totpSecsLeft / 30) * 37.7} 37.7`}
                        strokeLinecap="round"
                        transform="rotate(-90 8 8)"
                        style={{ transition: "stroke-dasharray 0.9s linear, stroke 0.3s" }}
                      />
                    </svg>
                  </div>
                </div>
                <input
                  className={inputCls}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="000000"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                  autoFocus
                  style={{ letterSpacing: "0.35em", fontSize: "20px", textAlign: "center" }}
                />
              </div>
              <div className="rounded-lg border border-[var(--border)] px-4 py-3" style={{ background: "var(--bg1)" }}>
                <p className="text-[11px] text-[var(--text3)] leading-relaxed">
                  Open your authenticator app (Google Authenticator, Authy, etc.) and enter the
                  6-digit code for this server. The code refreshes every 30 seconds — connect
                  before the timer expires.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 space-y-3">
          {/* BUG-08/09 fix: inline error so the user knows why Connect is blocked */}
          {connectError && (
            <p className="text-[#ef4444] text-xs text-right">{connectError}</p>
          )}
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2.5 rounded-lg text-sm text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--border)] transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleConnect}
              className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-all"
              style={{ background: "#6366f1", color: "#fff", boxShadow: "0 0 16px #6366f140" }}
            >
              Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
