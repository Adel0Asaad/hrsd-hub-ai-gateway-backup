// ai-gateway/src/kv/factory.ts
//
// Build the active KeyValueStore from config. Keep all knowledge of
// feature flags out of call sites — they just ask for "the store".

import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";
import type { KeyValueStore } from "./store.js";
import { InMemoryKeyValueStore } from "./in-memory.js";
import { createRedisKeyValueStore } from "./redis.js";

let instance: KeyValueStore | null = null;
let pending: Promise<KeyValueStore> | null = null;

export async function getKeyValueStore(): Promise<KeyValueStore> {
  if (instance) return instance;
  if (pending) return pending;

  pending = (async () => {
    if (config.cache.redis.enabled && config.cache.redis.url) {
      logger.info(
        { url: redactRedisUrl(config.cache.redis.url) },
        "kv_store_backend_redis",
      );
      instance = await createRedisKeyValueStore({
        url: config.cache.redis.url,
        keyPrefix: config.cache.redis.keyPrefix,
      });
    } else {
      logger.info("kv_store_backend_in_memory");
      instance = new InMemoryKeyValueStore();
    }
    return instance;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/** Mostly for tests / graceful shutdown. */
export async function disposeKeyValueStore(): Promise<void> {
  if (instance) {
    await instance.dispose();
    instance = null;
  }
}

function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "redis://[hidden]";
  }
}
