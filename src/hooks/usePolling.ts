// Completion-driven polling (audit PERF-002).
//
// setInterval fires on schedule even while the previous request is still in
// flight, so a slow host (or a long transfer holding the shared SSH session)
// makes requests pile up. Here the next run is scheduled only after the
// previous one settles, runs never overlap, and results that land after the
// poller was stopped (view hidden, session changed) can be discarded via
// `isCurrent()`.
//
// PollingActive lets a parent (e.g. a panel whose host isn't on screen) pause
// every poller beneath it without prop-drilling.

import { createContext, useContext, useEffect, useRef } from "react";

export type PollTask = (isCurrent: () => boolean) => Promise<unknown> | unknown;

/** Start polling; returns stop(). Pure (timers injectable) for tests. */
export function startPolling(
  task: PollTask,
  intervalMs: number,
  leading: boolean = true,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): () => void {
  let stopped = false;
  let handle: unknown = null;
  const isCurrent = () => !stopped;
  const tick = async () => {
    handle = null;
    try {
      await task(isCurrent);
    } catch {
      /* task reports its own errors */
    }
    if (!stopped) handle = timers.set(tick, intervalMs);
  };
  if (leading) void tick();
  else handle = timers.set(tick, intervalMs);
  return () => {
    stopped = true;
    if (handle !== null) timers.clear(handle);
  };
}

export const PollingActive = createContext<boolean>(true);

/**
 * Poll `task` every `intervalMs` (measured from completion) while `enabled`
 * and the surrounding PollingActive context are both true.
 */
export function usePolling(task: PollTask, intervalMs: number, enabled = true, leading = true): void {
  const active = useContext(PollingActive);
  const taskRef = useRef(task);
  taskRef.current = task;
  const on = enabled && active;
  useEffect(() => {
    if (!on) return;
    return startPolling((isCurrent) => taskRef.current(isCurrent), intervalMs, leading);
  }, [on, intervalMs, leading]);
}
