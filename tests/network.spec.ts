import { test, expect } from "@playwright/test";
import { isPrivateIp, formatLatency, calcStats, getRegionLabel } from "../src/utils/network";

// ── isPrivateIp ───────────────────────────────────────────────────────────────

test.describe("isPrivateIp", () => {
  test("10.x.x.x is private", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  test("172.16–31.x.x is private", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    // boundaries
    expect(isPrivateIp("172.15.0.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  test("192.168.x.x is private", () => {
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("192.168.0.0")).toBe(true);
    expect(isPrivateIp("192.169.0.0")).toBe(false);
  });

  // Bug #3 fix: loopback must be private (consistent with ping.rs::is_private_ip)
  test("127.x.x.x (loopback) is private", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.1.2.3")).toBe(true);
  });

  test("public IPs are not private", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("104.16.0.0")).toBe(false);
  });

  test("invalid strings return false", () => {
    expect(isPrivateIp("not-an-ip")).toBe(false);
    expect(isPrivateIp("")).toBe(false);
    expect(isPrivateIp("::1")).toBe(false); // IPv6 loopback
  });
});

// ── formatLatency ─────────────────────────────────────────────────────────────

test.describe("formatLatency", () => {
  test("sub-millisecond rounds to <1ms", () => {
    expect(formatLatency(0.4)).toBe("<1ms");
    expect(formatLatency(0)).toBe("<1ms");
  });

  test("normal ms values", () => {
    expect(formatLatency(1)).toBe("1ms");
    expect(formatLatency(42)).toBe("42ms");
    expect(formatLatency(999)).toBe("999ms");
  });

  test(">=1000ms converts to seconds", () => {
    expect(formatLatency(1000)).toBe("1.0s");
    expect(formatLatency(1500)).toBe("1.5s");
    expect(formatLatency(2000)).toBe("2.0s");
  });
});

// ── calcStats ─────────────────────────────────────────────────────────────────

test.describe("calcStats", () => {
  test("empty history returns nulls and 0 loss", () => {
    const s = calcStats([]);
    expect(s.avg).toBeNull();
    expect(s.max).toBeNull();
    expect(s.jitter).toBeNull();
    expect(s.loss).toBe(0);
    expect(s.uptime).toBe(100);
  });

  test("all successful pings compute correct avg and max", () => {
    const s = calcStats([
      { latency: 10, success: true },
      { latency: 20, success: true },
      { latency: 30, success: true },
    ]);
    expect(s.avg).toBe(20);
    expect(s.max).toBe(30);
    expect(s.loss).toBe(0);
    expect(s.uptime).toBe(100);
  });

  test("packet loss percentage is correct", () => {
    const s = calcStats([
      { latency: null, success: false },
      { latency: 10,   success: true },
      { latency: null, success: false },
      { latency: 10,   success: true },
    ]);
    expect(s.loss).toBe(50);
    expect(s.uptime).toBe(50);
  });

  test("100% packet loss", () => {
    const s = calcStats([
      { latency: null, success: false },
      { latency: null, success: false },
    ]);
    expect(s.avg).toBeNull();
    expect(s.max).toBeNull();
    expect(s.loss).toBe(100);
    expect(s.uptime).toBe(0);
  });

  test("single entry has null jitter", () => {
    const s = calcStats([{ latency: 50, success: true }]);
    expect(s.jitter).toBeNull();
    expect(s.avg).toBe(50);
  });
});

// ── getRegionLabel ────────────────────────────────────────────────────────────

test.describe("getRegionLabel", () => {
  test("private IPs label as local-network", () => {
    expect(getRegionLabel("192.168.1.1")).toBe("local-network");
    expect(getRegionLabel("10.0.0.1")).toBe("local-network");
    expect(getRegionLabel("127.0.0.1")).toBe("local-network");
  });
});
