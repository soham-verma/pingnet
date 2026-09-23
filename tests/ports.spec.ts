/**
 * Unit tests for src/utils/ports.ts (Network Info panel).
 */
import { test, expect } from "@playwright/test";
import {
  parsePortSpec, mergePortRows, isLoopback, serviceName, isQuietRow, MAX_SCAN_PORTS,
  type PortProbe, type ListeningSocket,
} from "../src/utils/ports";

test("parsePortSpec: list, ranges, dedupe, sort", () => {
  expect(parsePortSpec("443, 22 80,22 8000-8002")).toEqual({ ports: [22, 80, 443, 8000, 8001, 8002], error: null });
});

test("parsePortSpec: rejects junk and bad ranges", () => {
  expect(parsePortSpec("22,abc").error).toMatch(/Invalid port/);
  expect(parsePortSpec("0").error).toMatch(/Invalid range/);
  expect(parsePortSpec("70000").error).toMatch(/Invalid range/);
  expect(parsePortSpec("90-80").error).toMatch(/Invalid range/);
  expect(parsePortSpec("   ").error).toMatch(/at least one/);
});

test("parsePortSpec: enforces the port limit", () => {
  expect(parsePortSpec(`1-${MAX_SCAN_PORTS}`).error).toBeNull();
  expect(parsePortSpec(`1-${MAX_SCAN_PORTS + 1}`).error).toMatch(/limit/);
});

test("isLoopback", () => {
  expect(isLoopback("127.0.0.53")).toBe(true);
  expect(isLoopback("::1")).toBe(true);
  expect(isLoopback("0.0.0.0")).toBe(false);
  expect(isLoopback("*")).toBe(false);
});

test("serviceName: tcp and udp tables", () => {
  expect(serviceName(22)).toBe("ssh");
  expect(serviceName(14550, "udp")).toBe("mavlink");
  expect(serviceName(1)).toBeNull();
});

const sock = (port: number, address = "0.0.0.0", proto: "tcp" | "udp" = "tcp"): ListeningSocket =>
  ({ proto, address, port, process: "x", pid: 1 });
const probe = (port: number, state: PortProbe["state"]): PortProbe => ({ port, state, latency_ms: null });

test("mergePortRows: scan only (no SSH) — open / closed / filtered", () => {
  const rows = mergePortRows([probe(22, "open"), probe(80, "closed"), probe(443, "filtered")], null);
  expect(rows.map((r) => r.verdict)).toEqual(["open", "closed", "filtered"]);
  expect(rows[0].listening).toBeNull();
});

test("mergePortRows: scan + listening — active, blocked, local-only", () => {
  const rows = mergePortRows(
    [probe(22, "open"), probe(5432, "filtered"), probe(6379, "closed")],
    [sock(22), sock(5432), sock(6379, "127.0.0.1")],
  );
  const byPort = Object.fromEntries(rows.map((r) => [r.port, r.verdict]));
  expect(byPort).toEqual({ 22: "active", 5432: "blocked", 6379: "local-only" });
});

test("mergePortRows: listening ports outside the scan list are included", () => {
  const rows = mergePortRows([probe(22, "open")], [sock(22), sock(9999)]);
  expect(rows.map((r) => [r.port, r.verdict])).toEqual([[22, "active"], [9999, "listening"]]);
});

test("mergePortRows: udp sockets listed after tcp", () => {
  const rows = mergePortRows(null, [sock(14550, "0.0.0.0", "udp"), sock(22), sock(53, "127.0.0.53", "udp")]);
  expect(rows.map((r) => `${r.proto}:${r.port}:${r.verdict}`))
    .toEqual(["tcp:22:listening", "udp:53:local-only", "udp:14550:udp"]);
});

test("isQuietRow hides not-active rows only", () => {
  const rows = mergePortRows([probe(22, "open"), probe(80, "closed")], null);
  expect(rows.filter((r) => !isQuietRow(r)).map((r) => r.port)).toEqual([22]);
});
