import { test, expect } from "@playwright/test";
import { computeNextAlertState } from "../src/hooks/usePing";

// Shorthand for a passing ping with optional latency
function up(latency_ms = 10) {
  return { success: true, latency_ms };
}
// Shorthand for a failing ping
function down() {
  return { success: false, latency_ms: null };
}

const alertsOn = { alert_on_down: true, alert_on_recovery: true, alert_latency_ms: 200 };
const alertsOff = { alert_on_down: false, alert_on_recovery: false, alert_latency_ms: null };

// ── Down alert ────────────────────────────────────────────────────────────────

test.describe("down alert", () => {
  test("fires when host goes from up → down", () => {
    const { nextState, fire } = computeNextAlertState({
      prevState: "up", ...down(), ...alertsOn,
    });
    expect(fire).toBe("down");
    expect(nextState).toBe("down");
  });

  test("does NOT fire when already down (no duplicate alert)", () => {
    const { fire } = computeNextAlertState({
      prevState: "down", ...down(), ...alertsOn,
    });
    expect(fire).toBeNull();
  });

  test("fires on first-ever ping that fails (prevState null)", () => {
    const { fire } = computeNextAlertState({
      prevState: null, ...down(), ...alertsOn,
    });
    expect(fire).toBe("down");
  });

  test("does NOT fire when alert_on_down is false", () => {
    const { fire } = computeNextAlertState({
      prevState: "up", ...down(), ...alertsOff, alert_latency_ms: null,
    });
    expect(fire).toBeNull();
  });
});

// ── Recovery alert ────────────────────────────────────────────────────────────

test.describe("recovery alert", () => {
  test("fires when host goes from down → up", () => {
    const { nextState, fire } = computeNextAlertState({
      prevState: "down", ...up(), ...alertsOn,
    });
    expect(fire).toBe("recovery");
    expect(nextState).toBe("up");
  });

  test("does NOT fire when already up", () => {
    const { fire } = computeNextAlertState({
      prevState: "up", ...up(), ...alertsOn,
    });
    expect(fire).toBeNull();
  });

  test("does NOT fire when alert_on_recovery is false", () => {
    const { fire } = computeNextAlertState({
      prevState: "down", ...up(), alert_on_down: true, alert_on_recovery: false, alert_latency_ms: null,
    });
    expect(fire).toBeNull();
  });
});

// ── Latency alert (Bug #1 fix) ────────────────────────────────────────────────

test.describe("latency alert", () => {
  test("fires on transition from up → slow", () => {
    const { nextState, fire } = computeNextAlertState({
      prevState: "up", ...up(500), ...alertsOn,
    });
    expect(fire).toBe("slow");
    expect(nextState).toBe("slow");
  });

  // Bug #1 fix: must NOT fire on every subsequent slow ping
  test("does NOT fire again when already slow (no spam)", () => {
    const { fire } = computeNextAlertState({
      prevState: "slow", ...up(500), ...alertsOn,
    });
    expect(fire).toBeNull();
  });

  // Bug #1 fix: must NOT fire on first-ever ping when slow (prevState null)
  test("does NOT fire on first ping even if slow (prevState null)", () => {
    const { fire } = computeNextAlertState({
      prevState: null, ...up(500), ...alertsOn,
    });
    expect(fire).toBeNull();
  });

  test("returns to up state when latency normalises", () => {
    const { nextState, fire } = computeNextAlertState({
      prevState: "slow", ...up(10), ...alertsOn,
    });
    expect(nextState).toBe("up");
    expect(fire).toBeNull();
  });

  test("fires again if latency normalises then spikes again", () => {
    // Simulate: slow → up → slow
    const backToUp = computeNextAlertState({ prevState: "slow", ...up(10), ...alertsOn });
    expect(backToUp.nextState).toBe("up");

    const spikeAgain = computeNextAlertState({ prevState: backToUp.nextState, ...up(500), ...alertsOn });
    expect(spikeAgain.fire).toBe("slow");
  });

  test("does NOT fire when latency is below threshold", () => {
    const { fire } = computeNextAlertState({
      prevState: "up", ...up(100), ...alertsOn, // threshold is 200
    });
    expect(fire).toBeNull();
  });

  test("does NOT fire when alert_latency_ms is null", () => {
    const { fire } = computeNextAlertState({
      prevState: "up", ...up(500), ...alertsOff,
    });
    expect(fire).toBeNull();
  });

  test("recovery from down takes priority over slow latency", () => {
    // Host was down, comes back with high latency — should be "recovery", not "slow"
    const { fire, nextState } = computeNextAlertState({
      prevState: "down", ...up(500), ...alertsOn,
    });
    expect(fire).toBe("recovery");
    expect(nextState).toBe("slow");
  });
});
