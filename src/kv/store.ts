// ai-gateway/src/kv/store.ts
//
// A minimal key/value contract shared by the rate limiter and (when
// added) the conversation store. Two implementations live alongside
// this file: an in-memory one for single-instance deployments and a
// Redis-backed one for multi-instance.
//
// The pair of methods used by the rate limiter is `incrementAt` +
// `countIn`. The pair used by future conversation storage is the
// generic `get`/`set`/`del`. A single interface keeps the seam
// narrow and the swap trivial.

export interface KeyValueStore {
  /* --- Generic key/value ------------------------------------------- */
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;

  /* --- Sliding-window counters ------------------------------------- */
  /**
   * Records that `key` was hit at `timestamp` (ms epoch) and returns the
   * count of hits still inside the window [timestamp-windowMs, timestamp].
   *
   * Implementations MUST perform the record + count atomically so
   * concurrent callers can't both squeak in under the limit.
   */
  recordHit(
    key: string,
    windowMs: number,
    timestamp: number,
  ): Promise<{ count: number; oldestInWindow: number }>;

  /**
   * Returns the count of hits currently inside [now-windowMs, now]
   * WITHOUT recording a new hit. Used for "would this be allowed?"
   * probes before committing.
   */
  countIn(key: string, windowMs: number, now: number): Promise<number>;

  /** Release resources (timers, network connections). */
  dispose(): Promise<void>;
}
