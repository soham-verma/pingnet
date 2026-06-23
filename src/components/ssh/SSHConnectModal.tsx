import { useState } from "react";
import { SshConfig } from "../../types";

interface Props {
  hostname: string;
  ip: string;
  savedConfig: SshConfig | null;
  onConnect: (config: SshConfig, password: string) => void;
  onClose: () => void;
}

export default function SSHConnectModal({ hostname, ip, savedConfig, onConnect, onClose }: Props) {
  const [port, setPort] = useState(savedConfig?.port ?? 22);
  const [username, setUsername] = useState(savedConfig?.username ?? "");
  const [authType, setAuthType] = useState<"password" | "key">(savedConfig?.auth_type ?? "password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState(savedConfig?.key_path ?? "~/.ssh/id_rsa");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleConnect = () => {
    if (!username.trim()) return;
    const config: SshConfig = {
      port,
      username: username.trim(),
      auth_type: authType,
      key_path: authType === "key" ? keyPath : undefined,
    };
    onConnect(config, authType === "password" ? password : keyPassphrase);
  };

  const inputCls =
    "w-full bg-[#0a0a14] border border-[#1e1e35] rounded-lg px-3 py-2.5 text-sm text-white placeholder-[#374151] focus:outline-none focus:border-[#6366f1] transition-colors font-mono";
  const labelCls = "block text-[11px] text-[#4b5563] tracking-widest uppercase mb-1.5";

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="w-full max-w-md rounded-2xl border border-[#1e1e35] overflow-hidden"
        style={{ background: "#0f0f1a" }}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-[#1e1e35]" style={{ background: "#0a0a14" }}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-white font-semibold text-base">Connect via SSH</h2>
              <p className="text-[#4b5563] text-[12px] mt-0.5 font-mono">{hostname} · {ip}</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-[#4b5563] hover:text-white hover:bg-[#1e1e35] transition-all"
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
              <input
                className={inputCls}
                value={ip}
                readOnly
                style={{ opacity: 0.6 }}
              />
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
            <div className="flex gap-1 p-1 rounded-lg" style={{ background: "#0a0a14" }}>
              {(["password", "key"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setAuthType(t)}
                  className="flex-1 py-2 rounded-md text-[12px] font-medium transition-all"
                  style={
                    authType === t
                      ? { background: "#6366f1", color: "#fff" }
                      : { color: "#4b5563" }
                  }
                >
                  {t === "password" ? "Password" : "SSH Key"}
                </button>
              ))}
            </div>
          </div>

          {/* Auth fields */}
          {authType === "password" ? (
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
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#4b5563] hover:text-white text-[11px]"
                >
                  {showPassword ? "hide" : "show"}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Key file path</label>
                <input
                  className={inputCls}
                  placeholder="~/.ssh/id_rsa"
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                />
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
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#4b5563] hover:text-white text-[11px]"
                  >
                    {showPassphrase ? "hide" : "show"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-lg text-sm text-[#4b5563] hover:text-white hover:bg-[#1e1e35] transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleConnect}
            disabled={!username.trim()}
            className="px-5 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 transition-all"
            style={{ background: "#6366f1", color: "#fff", boxShadow: "0 0 16px #6366f140" }}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
