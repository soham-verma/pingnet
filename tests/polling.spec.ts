import { test, expect } from "@playwright/test";
import { startPolling } from "../src/hooks/usePolling";

// Manual timer queue so we control exactly when the next tick fires
function fakeTimers() {
  const q: { fn: () => void; ms: number; id: number }[] = [];
  let n = 0;
  return {
    q,
    set: (fn: () => void, ms: number) => { const id = ++n; q.push({ fn, ms, id }); return id; },
    clear: (h: unknown) => { const i = q.findIndex((t) => t.id === h); if (i >= 0) q.splice(i, 1); },
    fire: () => q.shift()?.fn(),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("never overlaps: next run is scheduled only after the previous settles", async () => {
  const t = fakeTimers();
  let inFlight = 0, maxInFlight = 0, runs = 0;
  let release!: () => void;
  const stop = startPolling(async () => {
    runs++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((r) => (release = r));
    inFlight--;
  }, 3000, true, t);
  await flush();
  expect(runs).toBe(1);
  expect(t.q.length).toBe(0);        // nothing scheduled while in flight
  release(); await flush();
  expect(t.q.length).toBe(1);        // scheduled after completion
  expect(t.q[0].ms).toBe(3000);
  t.fire(); await flush();
  expect(runs).toBe(2);
  expect(maxInFlight).toBe(1);
  stop();
});

test("stop() cancels the pending tick and marks late results stale", async () => {
  const t = fakeTimers();
  let current: (() => boolean) | null = null;
  let release!: () => void;
  const stop = startPolling(async (isCurrent) => {
    current = isCurrent;
    await new Promise<void>((r) => (release = r));
  }, 1000, true, t);
  await flush();
  stop();
  expect(current!()).toBe(false);    // result arriving now would be discarded
  release(); await flush();
  expect(t.q.length).toBe(0);        // no further polling after stop
});

test("a throwing task keeps polling", async () => {
  const t = fakeTimers();
  let runs = 0;
  const stop = startPolling(async () => { runs++; throw new Error("boom"); }, 500, true, t);
  await flush();
  expect(t.q.length).toBe(1);
  t.fire(); await flush();
  expect(runs).toBe(2);
  stop();
});

test("leading=false waits one interval before the first run", async () => {
  const t = fakeTimers();
  let runs = 0;
  const stop = startPolling(async () => { runs++; }, 700, false, t);
  await flush();
  expect(runs).toBe(0);
  expect(t.q[0].ms).toBe(700);
  t.fire(); await flush();
  expect(runs).toBe(1);
  stop();
});
