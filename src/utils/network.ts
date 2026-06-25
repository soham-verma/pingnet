export function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return (
    a === 127 ||                          // loopback — matches ping.rs::is_private_ip
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function formatLatency(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function getRegionLabel(ip: string): string {
  if (isPrivateIp(ip)) return "local-network";
  const first = parseInt(ip.split(".")[0]);
  // Very rough geo hint based on first octet ranges
  if (first >= 1 && first <= 50) return "ap-region";
  if (first >= 51 && first <= 100) return "us-region";
  if (first >= 101 && first <= 150) return "eu-region";
  return "public-net";
}

export function now(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function calcStats(history: { latency: number | null; success: boolean }[]) {
  const successful = history.filter((h) => h.success && h.latency !== null);
  const latencies = successful.map((h) => h.latency as number);

  const avg = latencies.length
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : null;

  const max = latencies.length ? Math.max(...latencies) : null;

  const jitter =
    latencies.length > 1
      ? Math.sqrt(
          latencies.reduce((acc, v) => acc + Math.pow(v - (avg ?? 0), 2), 0) /
            latencies.length
        )
      : null;

  const loss =
    history.length > 0
      ? ((history.filter((h) => !h.success).length / history.length) * 100)
      : 0;

  const uptime = 100 - loss;

  return { avg, max, jitter, loss, uptime };
}
