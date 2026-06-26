/**
 * Unit tests for src/utils/docker.ts
 * Runs with Playwright as the test runner (no browser — pure TS).
 */
import { test, expect } from "@playwright/test";
import {
  parseContainerState,
  stateColor,
  formatContainerName,
  formatDockerPorts,
  composeStatusCategory,
  composeStatusCount,
  formatDockerSize,
} from "../src/utils/docker";

// ── parseContainerState ───────────────────────────────────────────────────────

test("parseContainerState: running → running", () => {
  expect(parseContainerState("running")).toBe("running");
});

test("parseContainerState: restarting → running (treated as running)", () => {
  expect(parseContainerState("restarting")).toBe("running");
});

test("parseContainerState: exited → stopped", () => {
  expect(parseContainerState("exited")).toBe("stopped");
});

test("parseContainerState: dead → stopped", () => {
  expect(parseContainerState("dead")).toBe("stopped");
});

test("parseContainerState: removing → stopped", () => {
  expect(parseContainerState("removing")).toBe("stopped");
});

test("parseContainerState: paused → paused", () => {
  expect(parseContainerState("paused")).toBe("paused");
});

test("parseContainerState: created → other", () => {
  expect(parseContainerState("created")).toBe("other");
});

test("parseContainerState: unknown garbage → other", () => {
  expect(parseContainerState("flibbertigibbet")).toBe("other");
});

test("parseContainerState: uppercase RUNNING → running (case-insensitive)", () => {
  expect(parseContainerState("RUNNING")).toBe("running");
});

// ── stateColor ────────────────────────────────────────────────────────────────

test("stateColor: running → green", () => {
  expect(stateColor("running")).toBe("#22c55e");
});

test("stateColor: exited → red", () => {
  expect(stateColor("exited")).toBe("#ef4444");
});

test("stateColor: paused → amber", () => {
  expect(stateColor("paused")).toBe("#f59e0b");
});

test("stateColor: created → gray (other)", () => {
  expect(stateColor("created")).toBe("#6b7280");
});

// ── formatContainerName ───────────────────────────────────────────────────────

test("formatContainerName: strips leading slash", () => {
  expect(formatContainerName("/myapp-web-1")).toBe("myapp-web-1");
});

test("formatContainerName: no leading slash — passes through", () => {
  expect(formatContainerName("myapp-web-1")).toBe("myapp-web-1");
});

test("formatContainerName: multiple names — returns first", () => {
  expect(formatContainerName("/web,/db")).toBe("web");
});

test("formatContainerName: multiple names with slash — strips slash from first", () => {
  expect(formatContainerName("/nginx-1,/nginx-2")).toBe("nginx-1");
});

test("formatContainerName: empty string → empty string", () => {
  expect(formatContainerName("")).toBe("");
});

// ── formatDockerPorts ─────────────────────────────────────────────────────────

test("formatDockerPorts: empty string → empty string", () => {
  expect(formatDockerPorts("")).toBe("");
});

test("formatDockerPorts: whitespace-only string → empty string", () => {
  expect(formatDockerPorts("   ")).toBe("");
});

test("formatDockerPorts: single mapping — passes through", () => {
  expect(formatDockerPorts("0.0.0.0:80->80/tcp")).toBe("0.0.0.0:80->80/tcp");
});

test("formatDockerPorts: two mappings — passes through", () => {
  const input = "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp";
  expect(formatDockerPorts(input)).toBe(input);
});

test("formatDockerPorts: three mappings → first + '+2 more'", () => {
  const input = "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp, 0.0.0.0:8080->8080/tcp";
  expect(formatDockerPorts(input)).toBe("0.0.0.0:80->80/tcp, +2 more");
});

test("formatDockerPorts: four mappings → first + '+3 more'", () => {
  const parts = ["a:1->1/tcp", "a:2->2/tcp", "a:3->3/tcp", "a:4->4/tcp"];
  expect(formatDockerPorts(parts.join(", "))).toBe("a:1->1/tcp, +3 more");
});

// ── composeStatusCategory ─────────────────────────────────────────────────────

test("composeStatusCategory: 'running(3)' → running", () => {
  expect(composeStatusCategory("running(3)")).toBe("running");
});

test("composeStatusCategory: 'Running(1)' → running (case-insensitive)", () => {
  expect(composeStatusCategory("Running(1)")).toBe("running");
});

test("composeStatusCategory: 'exited(2)' → stopped", () => {
  expect(composeStatusCategory("exited(2)")).toBe("stopped");
});

test("composeStatusCategory: 'stopped' → stopped", () => {
  expect(composeStatusCategory("stopped")).toBe("stopped");
});

test("composeStatusCategory: mixed 'running(1) stopped(2)' → partial", () => {
  expect(composeStatusCategory("running(1) stopped(2)")).toBe("partial");
});

test("composeStatusCategory: empty string → other", () => {
  expect(composeStatusCategory("")).toBe("other");
});

test("composeStatusCategory: unknown string → other", () => {
  expect(composeStatusCategory("pulling")).toBe("other");
});

// ── composeStatusCount ────────────────────────────────────────────────────────

test("composeStatusCount: 'running(3)' → 3", () => {
  expect(composeStatusCount("running(3)")).toBe(3);
});

test("composeStatusCount: 'exited(0)' → 0", () => {
  expect(composeStatusCount("exited(0)")).toBe(0);
});

test("composeStatusCount: no parenthesised number → null", () => {
  expect(composeStatusCount("running")).toBeNull();
});

test("composeStatusCount: empty string → null", () => {
  expect(composeStatusCount("")).toBeNull();
});

// ── formatDockerSize ──────────────────────────────────────────────────────────

test("formatDockerSize: '1.5GB' → '1.5GB'", () => {
  expect(formatDockerSize("1.5GB")).toBe("1.5GB");
});

test("formatDockerSize: '  256MB  ' → '256MB' (trims whitespace)", () => {
  expect(formatDockerSize("  256MB  ")).toBe("256MB");
});

test("formatDockerSize: empty string → '0B'", () => {
  expect(formatDockerSize("")).toBe("0B");
});

test("formatDockerSize: whitespace-only → '0B'", () => {
  expect(formatDockerSize("   ")).toBe("0B");
});
