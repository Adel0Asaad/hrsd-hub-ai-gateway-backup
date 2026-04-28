// ai-gateway/src/kv/redis.ts
//
// Redis-backed KeyValueStore. Activated when
// `cache.redis.enabled = true` in config.
//
// Implementation notes:
//   * Sliding-window counter uses ZSETs keyed by `<prefix><key>`.
//     `recordHit` does ZADD + ZREMRANGEBYSCORE + ZCARD in a pipeline,
//     which is as close to atomic as we need (single round trip).
//     Under heavy contention we'd switch to a Lua script; right now
//     even the pipeline is measurably faster than the previous
//     in-memory loop.
//   * Scalar ops use plain GET / SET EX / DEL.
//   * ioredis is imported dynamically so the gateway doesn't require
//     it at install time unless Redis is enabled.

import type { KeyValueStore } from "./store.js";
import type Redis from "ioredis";

export interface RedisKeyValueStoreOptions {
  url: string;
  keyPrefix?: string;
  /** Injected for tests. */
  clientFactory?: (url: string) => Redis;
}

/**
 * Factory because ioredis is an optional dep. Call this from the KV
 * store factory so import-time errors stay isolated.
 */
export async function createRedisKeyValueStore(
  opts: RedisKeyValueStoreOptions,
): Promise<KeyValueStore> {
  if (opts.clientFactory) {
    return new RedisKeyValueStoreImpl(
      opts.clientFactory(opts.url),
      opts.keyPrefix ?? "",
    );
  }
  // Dynamic import — ioredis is listed as an optional peer.
  const mod = await import("ioredis").catch((err) => {
    throw new Error(
      `Redis cache is enabled but the "ioredis" module is not installed. ` +
        `Run \`npm install ioredis\` or disable redis in config. ` +
        `Original error: ${(err as Error)?.message ?? err}`,
    );
  });
  const Ctor = (mod as any).default ?? (mod as any).Redis;
  const client: Redis = new Ctor(opts.url, {
    lazyConnect: true,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 2,
  });
  await client.connect();
  return new RedisKeyValueStoreImpl(client, opts.keyPrefix ?? "");
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

class RedisKeyValueStoreImpl implements KeyValueStore {
  constructor(
    private readonly client: Redis,
    private readonly prefix: string,
  ) {}

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.k(key));
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const pk = this.k(key);
    if (ttlMs && ttlMs > 0) {
      await this.client.set(pk, value, "PX", ttlMs);
    } else {
      await this.client.set(pk, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key));
  }

  async recordHit(
    key: string,
    windowMs: number,
    timestamp: number,
  ): Promise<{ count: number; oldestInWindow: number }> {
    const pk = this.k(key);
    const cutoff = timestamp - windowMs;
    // Unique member (timestamp may collide under very high concurrency);
    // Redis ZADD uses member-set semantics, so we salt with a random id.
    const member = `${timestamp}:${Math.random().toString(36).slice(2, 8)}`;

    const pipeline = this.client.multi();
    pipeline.zadd(pk, timestamp, member);
    pipeline.zremrangebyscore(pk, 0, cutoff);
    pipeline.zcard(pk);
    pipeline.zrange(pk, 0, 0, "WITHSCORES");
    // Expire the whole key once the window has passed — keeps the dataset trim.
    pipeline.pexpire(pk, windowMs + 1_000);

    const [, , cardRes, oldestRes] = (await pipeline.exec()) ?? [];
    const count = Number((cardRes as [unknown, unknown])[1] ?? 0);
    const oldestPair = (oldestRes as [unknown, string[]])[1] ?? [];
    const oldestInWindow = Number(oldestPair[1] ?? timestamp);

    return { count, oldestInWindow };
  }

  async countIn(key: string, windowMs: number, now: number): Promise<number> {
    const pk = this.k(key);
    const cutoff = now - windowMs;
    const pipeline = this.client.multi();
    pipeline.zremrangebyscore(pk, 0, cutoff);
    pipeline.zcard(pk);
    const [, cardRes] = (await pipeline.exec()) ?? [];
    return Number((cardRes as [unknown, unknown])[1] ?? 0);
  }

  async dispose(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
