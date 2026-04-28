// ai-gateway/src/observability/logger.ts
//
// Central pino logger for the gateway.
//
// Design goals:
//   * Non-blocking. All log writes go through pino's async transport on a
//     dedicated worker thread in production; the hot path only enqueues.
//   * Bounded memory. We never buffer to disk, never batch in user space
//     beyond pino's own queue. Log rotation is a platform concern
//     (container log driver, journald, etc.) — the app only ever writes
//     to stdout.
//   * Production-safe by default. PII and auth headers are redacted;
//     pretty-printing is dev-only.
//   * Zero-cost when disabled. `LOG_LEVEL=silent` or per-level gating
//     means serialising code never runs below threshold.
//
// Usage:
//   import { logger } from "./observability/logger.js";
//   logger.info({ userId, route: "/chat" }, "request started");
//
// To get a child logger bound to request context, use
// `requestLogger.ts` + `context.ts` which attach a traceId automatically.

import pino from "pino";
import type { LoggerOptions, DestinationStream } from "pino";

/* ------------------------------------------------------------------ */
/*  Level + transport resolution                                       */
/* ------------------------------------------------------------------ */

const LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Fields we never want to log under any circumstance. pino's redact
 * option replaces these with `[Redacted]` in-place.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "req.body.password",
  "req.body.token",
  "req.body.apiKey",
  "headers.authorization",
  "headers.cookie",
  "password",
  "token",
  "apiKey",
  "api_key",
  "secret",
  "*.nationalId",
  "*.national_id",
  "*.idNumber",
  "*.id_number",
];

const baseOpts: LoggerOptions = {
  level: LEVEL,
  // Timestamp in ISO-8601 form — friendlier to downstream log processors
  // than pino's default epoch-ms integer.
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  // Stable base fields every line carries.
  base: {
    service: "ai-gateway",
    env: process.env.NODE_ENV ?? "development",
  },
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
  // Gracefully drop non-serialisable values (e.g. circular refs from
  // express.Request) rather than crashing the logger.
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
};

/* ------------------------------------------------------------------ */
/*  Transport selection                                                */
/* ------------------------------------------------------------------ */

/**
 * In production we use pino's async transport on a worker thread. This
 * moves JSON serialisation + stdout writes off the main event loop,
 * which is the single biggest source of logging-related latency spikes.
 *
 * In development we opt into `pino-pretty` on the main thread for
 * readability. The two never mix: pretty-print in prod creates a
 * performance cliff and ruins structured-log ingestion.
 */
function buildTransport(): DestinationStream | undefined {
  if (IS_PROD) {
    // Async, worker-thread JSON transport — non-blocking.
    return pino.transport({
      target: "pino/file",
      options: { destination: 1 }, // fd 1 = stdout
    });
  }
  // Dev: pretty, synchronous, single-threaded. Good enough locally.
  try {
    return pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname,service,env",
      },
    });
  } catch {
    // pino-pretty not installed → fall back to plain stdout. Never crash.
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton                                                          */
/* ------------------------------------------------------------------ */

export const logger = pino(baseOpts, buildTransport());

/**
 * Structured HTTP-error serializer used by request/error middleware.
 * Keeps the payload compact and production-safe.
 */
export function serializeHttpError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      // Stack only in non-prod — in prod we rely on structured code + traceId
      // to correlate, not a free-text blob that bloats logs.
      ...(IS_PROD ? {} : { stack: err.stack }),
    };
  }
  return { value: String(err) };
}
