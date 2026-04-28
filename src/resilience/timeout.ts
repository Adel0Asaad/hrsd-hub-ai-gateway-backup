// ai-gateway/src/resilience/timeout.ts
//
// Tiny helpers around AbortSignal that make it easy to give every
// outgoing call a deadline without leaking timers.
//
// Semantics:
//   * `timeoutSignal(ms)`             — a brand-new deadline.
//   * `linkSignals(parent, child)`    — aborts when either fires. Used
//                                       to propagate a request-level
//                                       deadline *and* a per-call one.
//   * `isAbortError(err)`             — identifies timeout / disconnect.

export function timeoutSignal(ms: number): AbortSignal {
  // Node 18+ has AbortSignal.timeout built in; we use it rather than
  // shipping our own timer to avoid the "forgot to clear" class of bug.
  return AbortSignal.timeout(ms);
}

/**
 * Returns a signal that aborts when ANY of the input signals aborts.
 * Equivalent to AbortSignal.any() but supported on older Node too.
 */
export function linkSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const active = signals.filter((s): s is AbortSignal => !!s);
  if (active.length === 0) {
    // Nothing to link — return a never-aborting signal.
    return new AbortController().signal;
  }
  if (active.length === 1) return active[0];

  // AbortSignal.any is available on Node 20+; fall back to manual wiring.
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any(active) as AbortSignal;
  }
  const controller = new AbortController();
  const onAbort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const s of active) {
    if (s.aborted) {
      onAbort(s.reason);
      break;
    }
    s.addEventListener("abort", () => onAbort(s.reason), { once: true });
  }
  return controller.signal;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return (
    e.name === "AbortError" ||
    e.name === "TimeoutError" ||
    e.code === "ABORT_ERR" ||
    e.code === "ERR_ABORTED" ||
    e.code === "UND_ERR_ABORTED"
  );
}
