// ── Pure Docker utility functions (no Tauri/browser APIs) ────────────────────
//
// These are tested by tests/docker.spec.ts.

export type ContainerStateCategory = "running" | "stopped" | "paused" | "other";

/**
 * Map a raw Docker container state string to a normalized category.
 * Docker states: running, exited, dead, removing, paused, created, restarting
 */
export function parseContainerState(state: string): ContainerStateCategory {
  switch (state.toLowerCase()) {
    case "running":
    case "restarting":
      return "running";
    case "exited":
    case "dead":
    case "removing":
      return "stopped";
    case "paused":
      return "paused";
    default:
      return "other";
  }
}

/**
 * Return a CSS color string for a container state.
 */
export function stateColor(state: string): string {
  switch (parseContainerState(state)) {
    case "running":  return "#22c55e";
    case "stopped":  return "#ef4444";
    case "paused":   return "#f59e0b";
    default:         return "#6b7280";
  }
}

/**
 * Strip the leading slash Docker prepends to container names.
 * If multiple names exist (comma-separated), return the first.
 * Examples:
 *   "/myapp-web-1"        → "myapp-web-1"
 *   "/web,/db"            → "web"
 *   "myapp-web-1"         → "myapp-web-1"
 */
export function formatContainerName(names: string): string {
  return names.split(",")[0].trim().replace(/^\//, "");
}

/**
 * Abbreviate a long ports string to keep the UI compact.
 * Shows at most two mappings, then "+N more".
 * Empty string → "".
 * Examples:
 *   "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp, 0.0.0.0:8080->8080/tcp"
 *     → "0.0.0.0:80->80/tcp, +2 more"
 */
export function formatDockerPorts(ports: string): string {
  if (!ports.trim()) return "";
  const parts = ports.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 2) return parts.join(", ");
  return `${parts[0]}, +${parts.length - 1} more`;
}

/**
 * Categorize a compose project status string.
 * Docker Compose status examples:
 *   "running(3)"     → all services running
 *   "running(1)"     → partial (if < total services)
 *   "exited(2)"      → stopped
 *   ""               → other
 */
export function composeStatusCategory(
  status: string
): "running" | "partial" | "stopped" | "other" {
  const s = status.toLowerCase();
  // Check partial (mixed) before pure running so "running(1) stopped(2)" → partial
  if (s.includes("running") && s.includes("stopped")) return "partial";
  if (s.startsWith("running")) return "running";
  if (s.startsWith("exited") || s === "stopped") return "stopped";
  return "other";
}

/**
 * Extract the numeric count from a compose status like "running(3)".
 * Returns null if the count is not present.
 */
export function composeStatusCount(status: string): number | null {
  const m = status.match(/\((\d+)\)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Return a short label for docker system df size values.
 * Passes through strings that already have units (e.g. "1.5GB").
 */
export function formatDockerSize(raw: string): string {
  return raw.trim() || "0B";
}

/**
 * Format repository + tag as a single image reference.
 */
export function formatDockerImageRef(repository: string, tag: string): string {
  if (repository === "<none>") return "<untagged>";
  if (tag === "<none>") return repository;
  return `${repository}:${tag}`;
}

/**
 * Shorten a Docker ID for display (strip sha256: prefix, truncate).
 */
export function shortenDockerId(id: string, len = 12): string {
  const bare = id.replace(/^sha256:/, "");
  return bare.length <= len ? bare : bare.slice(0, len);
}

/** Built-in Docker networks that cannot be removed. */
export function isDefaultDockerNetwork(name: string): boolean {
  return name === "bridge" || name === "host" || name === "none";
}

/**
 * Extract compose project + service from docker inspect JSON (array or object).
 */
export function parseComposeLabelsFromInspect(
  inspectJson: string
): { project: string; service: string } | null {
  try {
    const parsed = JSON.parse(inspectJson) as unknown;
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== "object") return null;
    const labels = (obj as { Config?: { Labels?: Record<string, string> } }).Config?.Labels;
    if (!labels) return null;
    const project = labels["com.docker.compose.project"];
    const service = labels["com.docker.compose.service"];
    if (!project || !service) return null;
    return { project, service };
  } catch {
    return null;
  }
}
