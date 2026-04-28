// ai-gateway/src/resilience/retry.ts
//
// Exponential backoff with full jitter. Designed for idempotent
// upstream calls only (GETs, LLM chat completions, etc.).
//
// Do NOT retry mutating tool invocations — that's a data-loss/
// double-submit hazard. The orchestrator enforces this by only
// passing `retryable=true` on idempotent paths.

import { isAbortError } from "./timeout.js";

export interface RetryOptions {
  /** How many retries after the initial attempt. Total attempts = retries + 1. */
  retries: number;
  /** First retry delay in ms. Subsequent attempts double up to maxDelayMs. */
  baseDelayMs?: number;
  /** Cap for the delay so large retry counts don't explode. */
  maxDelayMs?: number;
  /** Called with each error; if it returns false we stop retrying. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Optional abort signal; when aborted we stop retrying immediately. */
  signal?: AbortSignal;
  /** Optional hook, used by tests / metrics. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const {
    retries,
    baseDelayMs = 200,
    maxDelayMs = 5_000,
    shouldRetry = defaultShouldRetry,
    signal,
    onRetry,
  } = opts;

  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= retries) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Client disconnected or our deadline fired — don't bother retrying.
      if (isAbortError(err)) throw err;
      if (attempt === retries) break;
      if (!shouldRetry(err, attempt)) break;

      // Full jitter: between 0 and (base * 2^attempt), capped.
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = Math.floor(Math.random() * cap);
      onRetry?.(err, attempt, delay);
      await sleep(delay, signal);
      attempt++;
    }
  }

  throw lastErr;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Default "should I retry" heuristic:
 *   * Network-level fetch failures (TypeError with /fetch|network|ECONN/)
 *   * HTTP 408, 425, 429, 500, 502, 503, 504
 * Other errors — validation, auth — are fatal.
 */
export function defaultShouldRetry(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as { status?: number; statusCode?: number; message?: string; name?: string };
  const status = anyErr.status ?? anyErr.statusCode;
  if (typeof status === "number") {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
  }
  const msg = (anyErr.message ?? "").toLowerCase();
  if (/fetch|network|econn|etimedout|socket|enotfound|eai_again/.test(msg)) {
    return true;
  }
  return false;
}
