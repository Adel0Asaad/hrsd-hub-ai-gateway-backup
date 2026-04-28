// ai-gateway/src/sdp/client.ts
//
// HTTP client for sdp-service.
//
// Responsibilities:
//   * Hard-timeout every outgoing request (default 3s).
//   * Retry idempotent GETs on transient errors with backoff.
//   * Short-TTL in-process cache keyed by userId — the chat-context
//     bundle rarely changes within a session so repeat lookups are
//     served from memory. This is the single biggest relief valve
//     for sdp-service under load.
//   * Expose a narrow `ChatContextFetcher` seam so the orchestrator
//     stays pure and tests can swap in a fake.

import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { getContext } from "../observability/context.js";
import { linkSignals, timeoutSignal, isAbortError } from "../resilience/timeout.js";
import { retry } from "../resilience/retry.js";

/**
 * The chat-context bundle returned by sdp-service's
 * {@code GET /api/users/{id}/chat-context} endpoint.
 */
export interface ChatContextBundle {
  userId: string;
  userName: string;
  systemPrompt: string;
  tools: string[];
}

export interface ChatContextFetcher {
  fetch(userId: string, signal?: AbortSignal): Promise<ChatContextBundle>;
}

/* ------------------------------------------------------------------ */
/*  Error type                                                         */
/* ------------------------------------------------------------------ */

export class ChatContextFetchError extends Error {
  constructor(
    public readonly statusCode: number | undefined,
    public readonly userId: string,
    message: string,
  ) {
    super(message);
    this.name = "ChatContextFetchError";
  }
}

/* ------------------------------------------------------------------ */
/*  HTTP implementation                                                */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  bundle: ChatContextBundle;
  expiresAt: number;
}

export interface HttpChatContextFetcherOptions {
  baseUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Injected for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export class HttpChatContextFetcher implements ChatContextFetcher {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: HttpChatContextFetcherOptions = {}) {
    this.baseUrl = opts.baseUrl ?? config.sdpService.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? config.sdpService.timeoutMs;
    this.cacheTtlMs = opts.cacheTtlMs ?? config.sdpService.contextCacheTtlMs;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async fetch(userId: string, signal?: AbortSignal): Promise<ChatContextBundle> {
    // 1. Cache probe.
    if (this.cacheTtlMs > 0) {
      const hit = this.cache.get(userId);
      if (hit && hit.expiresAt > Date.now()) {
        return hit.bundle;
      }
    }

    const url = `${this.baseUrl}/api/users/${encodeURIComponent(userId)}/chat-context`;

    // 2. Execute with retry + per-attempt timeout.
    const bundle = await retry(
      async () => this.fetchOnce(url, userId, signal),
      {
        retries: 2,
        baseDelayMs: 150,
        maxDelayMs: 1_000,
        signal,
        onRetry: (err, attempt, delay) => {
          logger.warn(
            { userId, attempt, delay, err: (err as Error)?.message },
            "sdp_fetch_retry",
          );
        },
      },
    );

    // 3. Cache.
    if (this.cacheTtlMs > 0) {
      this.cache.set(userId, {
        bundle,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
    }

    return bundle;
  }

  /** Drop a single user's cached bundle. Useful if backend mutates. */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /** Drop the whole cache (e.g. on SIGHUP). */
  clear(): void {
    this.cache.clear();
  }

  private async fetchOnce(
    url: string,
    userId: string,
    parentSignal?: AbortSignal,
  ): Promise<ChatContextBundle> {
    // Keep the two signals separate so we can tell which one fired.
    // A caller-cancel and an our-deadline abort look identical to fetch
    // but mean very different things for diagnosis.
    const deadline = timeoutSignal(this.timeoutMs);
    const signal = linkSignals(parentSignal, deadline);
    const started = Date.now();

    // Forward the current request's traceId so sdp-service logs can be
    // correlated end-to-end with the gateway's logs. If there's no
    // ambient context (e.g. a warm-up call from startup code), just
    // skip the header — downstream will mint its own.
    const ctx = getContext();
    const headers: Record<string, string> = { accept: "application/json" };
    if (ctx?.traceId) headers["x-trace-id"] = ctx.traceId;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        signal,
        headers,
      });
    } catch (err) {
      const elapsed = Date.now() - started;
      const rawMsg = (err as Error)?.message ?? "network error";
      // Log the underlying error exactly once so operators never have to
      // guess whether the label matches reality.
      logger.warn(
        {
          userId,
          url,
          elapsedMs: elapsed,
          errName: (err as Error)?.name,
          errCode: (err as { code?: string })?.code,
          errCause: safeCause(err),
          errMsg: rawMsg,
        },
        "sdp_fetch_failed",
      );

      if (isAbortError(err)) {
        // Only call it a timeout when OUR deadline fired.
        if (deadline.aborted && !parentSignal?.aborted) {
          throw new ChatContextFetchError(
            undefined,
            userId,
            `sdp-service request timed out after ${this.timeoutMs}ms`,
          );
        }
        if (parentSignal?.aborted) {
          throw new ChatContextFetchError(
            undefined,
            userId,
            `sdp-service request aborted by caller after ${elapsed}ms`,
          );
        }
        // Abort-shaped error with neither signal aborted — means fetch
        // itself reported an abort from elsewhere (connection reset).
        throw new ChatContextFetchError(
          undefined,
          userId,
          `sdp-service connection aborted after ${elapsed}ms: ${rawMsg}`,
        );
      }
      // Surface the underlying cause (ECONNREFUSED, ENOTFOUND, etc.) —
      // that's what tells us whether the URL is wrong, the service is
      // down, or the network path is broken.
      const cause = safeCause(err);
      throw new ChatContextFetchError(
        undefined,
        userId,
        `sdp-service unreachable after ${elapsed}ms: ${rawMsg}${
          cause ? ` (cause: ${cause})` : ""
        }`,
      );
    }

    if (!res.ok) {
      throw new ChatContextFetchError(
        res.status,
        userId,
        `sdp-service returned ${res.status} for user ${userId}`,
      );
    }

    const data = (await res.json()) as ChatContextBundle;
    if (
      !data ||
      typeof data.systemPrompt !== "string" ||
      !Array.isArray(data.tools) ||
      typeof data.userId !== "string"
    ) {
      throw new ChatContextFetchError(
        res.status,
        userId,
        `sdp-service returned a malformed chat-context bundle for ${userId}`,
      );
    }
    return data;
  }
}

/**
 * Best-effort extraction of the "real" reason behind a thrown fetch
 * failure. Node's undici wraps the low-level cause (ECONNREFUSED,
 * ENOTFOUND, etc.) in `err.cause`. That's where the diagnostic signal
 * lives — `err.message` is often just the generic "fetch failed".
 */
function safeCause(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const cause = (err as { cause?: unknown }).cause;
  if (!cause) return undefined;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${cause.name}: ${cause.message} [${code}]` : `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}
