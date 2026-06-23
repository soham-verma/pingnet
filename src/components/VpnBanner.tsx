import { VpnStatus } from "../types";
import { isPrivateIp } from "../utils/network";

interface Props {
  vpnStatus: VpnStatus;
  ip: string;
  errorKind: string | null;
  onDismiss: () => void;
}

export default function VpnBanner({ vpnStatus, ip, errorKind, onDismiss }: Props) {
  const privateIp = isPrivateIp(ip);

  const vpnNames = [
    ...vpnStatus.names,
    ...vpnStatus.interfaces,
  ].filter(Boolean);

  const vpnLabel = vpnNames.length > 0 ? vpnNames.join(", ") : "a VPN";

  let message = "";
  let tags: string[] = [];

  if (vpnStatus.active && privateIp) {
    message = `Could not reach this host. ${vpnLabel} appears active on your workstation which may be interfering with local subnet routing for ${ip}.`;
    tags = ["VPN ACTIVE", "HOST OFFLINE", "SUBNET CONFLICT"];
  } else if (vpnStatus.active && !privateIp) {
    message = `Could not reach ${ip}. ${vpnLabel} is active — your traffic may be routed through a VPN exit node that blocks ICMP or cannot reach this host.`;
    tags = ["VPN ACTIVE", "ICMP BLOCKED"];
  } else if (!vpnStatus.active && privateIp && errorKind === "no_route") {
    message = `No route to ${ip}. This is a private address — you may need to connect to a VPN or be on the same local network.`;
    tags = ["NO VPN", "PRIVATE IP", "ROUTE MISSING"];
  } else if (!vpnStatus.active && privateIp) {
    message = `Could not reach ${ip}. This is a private IP — make sure you're on the same network or connected to a VPN that covers this subnet.`;
    tags = ["NO ROUTE", "PRIVATE IP"];
  } else {
    message = `Could not reach ${ip}. Check that the host is online, firewall rules allow ICMP, and your network path is intact.`;
    tags = ["HOST OFFLINE", "CHECK FIREWALL"];
  }

  return (
    <div
      className="rounded-xl border-l-4 border-[#f59e0b] p-4 flex items-start gap-4"
      style={{ background: "#1a1400", borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderTopColor: "#2a2000", borderRightColor: "#2a2000", borderBottomColor: "#2a2000" }}
    >
      <div className="flex-shrink-0 mt-0.5">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M10 2L18 17H2L10 2Z" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M10 8v4M10 14v1" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-semibold text-[#f59e0b] text-sm mb-1">
          Smart Failure Diagnostics
        </div>
        <p className="text-[#a0836e] text-[13px] leading-relaxed mb-3">{message}</p>
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 rounded text-[10px] font-mono font-medium tracking-wide"
              style={{ background: "#2a1a00", color: "#f59e0b", border: "1px solid #3a2500" }}
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      <button
        onClick={onDismiss}
        className="flex-shrink-0 text-[#4b3a1e] hover:text-[#f59e0b] transition-colors text-lg leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
