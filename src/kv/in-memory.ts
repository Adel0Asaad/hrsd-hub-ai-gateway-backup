// ai-gateway/src/kv/in-memory.ts
//
// Single-process, in-memory KeyValueStore. The default backing for
// small deployments, dev, and tests.
//
// Memory is bounded by a periodic sweeper that evicts expired
// scalar entries and fully-stale counter windows.

import type { KeyValueStore } from "./store.js";

interface ScalarEntry {
  value: string;
  expiresAt?: number;
}

export interface InMemoryKeyValueStoreOptions {
  /** How often the sweeper runs, in ms. 0 disables it. */
  cleanupIntervalMs?: number;
  /** Max window that counters are expected to care about — used by the sweeper. */
  counterMaxWindowMs?: number;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly scalars = new Map<string, ScalarEntry>();
  private readonly counters = new Map<string, number[]>();
  private readonly cleanupTimer?: NodeJS.Timeout;
  private readonly counterMaxWindowMs: number;

  constructor(opts: InMemoryKeyValueStoreOptions = {}) {
    const cleanupIntervalMs = opts.cleanupIntervalMs ?? 60_000;
    this.counterMaxWindowMs = opts.counterMaxWindowMs ?? 10 * 60_000;
    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.sweep(), cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  async get(key: string): Promise<string | null> {
    const entry = this.scalars.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.scalars.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.scalars.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
    });
  }

  async del(key: string): Promise<void> {
    this.scalars.delete(key);
  }

  async recordHit(
    key: string,
    windowMs: number,
    timestamp: number,
  ): Promise<{ count: number; oldestInWindow: number }> {
    const fresh = this.fresh(key, windowMs, timestamp);
    fresh.push(timestamp);
    this.counters.set(key, fresh);
    return {
      count: fresh.length,
      oldestInWindow: fresh[0]!,
    };
  }

  async countIn(key: string, windowMs: number, now: number): Promise<number> {
    const fresh = this.fresh(key, windowMs, now);
    // Persist the pruned list back — cheap and keeps memory bounded.
    this.counters.set(key, fresh);
    return fresh.length;
  }

  async dispose(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.scalars.clear();
    this.counters.clear();
  }

  /** Exposed for tests. */
  clear(): void {
    this.scalars.clear();
    this.counters.clear();
  }

  private fresh(key: string, windowMs: number, now: number): number[] {
    const prior = this.counters.get(key);
    if (!prior) return [];
    const cutoff = now - windowMs;
    const out: number[] = [];
    for (const t of prior) {
      if (t > cutoff) out.push(t);
    }
    return out;
  }

  private sweep(): void {
    const now = Date.now();
    // Scalars.
    for (const [k, e] of this.scalars) {
      if (e.expiresAt !== undefined && e.expiresAt <= now) {
        this.scalars.delete(k);
      }
    }
    // Counters — drop entirely stale buckets (last hit outside widest window).
    for (const [k, stamps] of this.counters) {
      const newest = stamps[stamps.length - 1];
      if (newest === undefined || now - newest >= this.counterMaxWindowMs) {
        this.counters.delete(k);
      }
    }
  }
}
