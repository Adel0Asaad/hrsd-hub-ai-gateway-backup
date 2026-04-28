// ai-gateway/src/observability/context.ts
//
// Per-request context carried across async boundaries via
// AsyncLocalStorage. Any code anywhere in the request lifetime can
// look up the current traceId without plumbing it through every
// function signature.
//
// This is the ONLY piece of implicit state we introduce. It's opt-in
// (via getContext()) — if you forget to call `runWithContext`, you
// just get `undefined`, never a crash.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  /** Correlation ID propagated across services (X-Trace-Id header). */
  traceId: string;
  /** Authenticated user id, once validated. */
  userId?: string;
  /** Human-friendly route label (e.g. "/chat"). */
  route?: string;
  /** Epoch ms when the request entered the gateway. */
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Small helper the request-logger middleware uses to mint a new
 * context. Callers outside the HTTP path rarely need this.
 */
export function newContext(
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    traceId: overrides.traceId ?? randomUUID(),
    userId: overrides.userId,
    route: overrides.route,
    startedAt: overrides.startedAt ?? Date.now(),
  };
}
