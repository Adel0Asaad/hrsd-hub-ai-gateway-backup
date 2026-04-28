// ai-gateway/src/resilience/circuit-breaker.ts
//
// Minimal three-state circuit breaker (closed / open / half-open)
// tuned for outgoing upstream calls.
//
// Why hand-rolled instead of `opossum`?
//   * No external runtime dep.
//   * We need zero-dependency behaviour for tests (no event loop
//     timers leaking between cases).
//   * Behaviour here is exactly what we need — protecting the LLM
//     call — and nothing more.
//
// Semantics:
//   * closed     → calls pass through; on failure, count errors.
//   * open       → calls fail fast with `CircuitOpenError`. After
//                  resetAfterMs a single probe call is allowed.
//   * half-open  → one probe call is in flight. If it succeeds we
//                  close the breaker; if it fails we re-open it for
//                  another resetAfterMs.

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** Time to wait before allowing a probe call. */
  resetAfterMs: number;
  /** Optional hook for state transitions (useful for metrics). */
  onStateChange?: (state: CircuitState, reason?: string) => void;
}

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("circuit_open");
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  /** Promise in flight while we're probing the upstream in half-open. */
  private probe: Promise<unknown> | null = null;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  /**
   * Executes `fn` through the breaker. Throws `CircuitOpenError` when
   * the breaker is open (or the probe is already in flight in half-open).
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    // OPEN → fail fast until reset window elapses.
    if (this.state === "open") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.opts.resetAfterMs) {
        throw new CircuitOpenError(this.opts.resetAfterMs - elapsed);
      }
      // Transition to half-open and continue into the probe path.
      this.transition("half-open", "reset_timeout_elapsed");
    }

    // HALF-OPEN → only one probe call is allowed at a time; others
    // fail fast. This avoids a thundering herd on a flaky upstream.
    if (this.state === "half-open" && this.probe !== null) {
      throw new CircuitOpenError(0);
    }

    const call = (async () => {
      try {
        const result = await fn();
        this.onSuccess();
        return result;
      } catch (err) {
        this.onFailure();
        throw err;
      }
    })();

    if (this.state === "half-open") {
      this.probe = call;
      call.finally(() => {
        this.probe = null;
      });
    }

    return call;
  }

  /** Observability hook for metrics/health. */
  getState(): CircuitState {
    return this.state;
  }

  /** Manual reset — rarely used, but handy for ops tooling. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.probe = null;
    this.transition("closed", "manual_reset");
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== "closed") {
      this.transition("closed", "probe_succeeded");
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.state === "half-open") {
      // Probe failed — re-open with a fresh cool-down.
      this.openedAt = Date.now();
      this.transition("open", "probe_failed");
      return;
    }
    if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.openedAt = Date.now();
      this.transition("open", "threshold_exceeded");
    }
  }

  private transition(next: CircuitState, reason: string): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStateChange?.(next, reason);
  }
}
