// ai-gateway/src/middleware/request-logger.ts
//
// Assigns a traceId to every inbound request, installs an
// AsyncLocalStorage context so downstream code can look it up without
// plumbing, and emits a single structured access-log line on finish.
//
// Heavy code paths should use the `traceId` header when calling
// downstream services so one correlation id spans the gateway,
// sdp-service, and mcp-server in log aggregators.

import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

import { logger } from "../observability/logger.js";
import { runWithContext, newContext } from "../observability/context.js";
import {
  httpRequestDuration,
  httpRequestsTotal,
  statusClass,
} from "../observability/metrics.js";
import { config } from "../config/env.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Unique correlation ID propagated through the entire request lifecycle. */
      traceId: string;
      /** Back-compat alias for traceId — some older code reads this name. */
      correlationId: string;
    }
  }
}

const TRACE_HEADER = "x-trace-id";
const LEGACY_HEADER = "x-correlation-id";

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming =
    (req.headers[TRACE_HEADER] as string) ||
    (req.headers[LEGACY_HEADER] as string) ||
    randomUUID();

  req.traceId = incoming;
  req.correlationId = incoming;
  res.setHeader(TRACE_HEADER, incoming);

  const start = Date.now();
  const ctx = newContext({
    traceId: incoming,
    route: `${req.method} ${req.path}`,
    startedAt: start,
  });

  // Sampling: at high RPS we don't need every line. Errors always log
  // (bypass sampling in the finish handler below).
  const shouldSampleAccess =
    Math.random() < config.metrics.accessLogSampling;

  let observed = false;
  const finish = () => {
    if (observed) return;
    observed = true;
    const durationMs = Date.now() - start;
    const cls = statusClass(res.statusCode);
    // Prefer a route template over the request path to keep label
    // cardinality bounded. Falls back to the path only when Express
    // couldn't resolve a route (404s etc.).
    const routeLabel =
      (req.route && typeof req.route.path === "string" ? req.route.path : req.path) ??
      "unknown";

    if (config.metrics.enabled) {
      httpRequestDuration
        .labels(req.method, routeLabel, cls)
        .observe(durationMs / 1000);
      httpRequestsTotal.labels(req.method, routeLabel, cls).inc();
    }

    const level =
      res.statusCode >= 500 ? "error"
      : res.statusCode >= 400 ? "warn"
      : shouldSampleAccess ? "info" : "debug";

    logger[level](
      {
        traceId: incoming,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
      },
      "http_request",
    );
  };
  // `close` fires when the client disconnects before `finish`; we
  // still need to observe the request so metrics don't silently drop.
  res.on("finish", finish);
  res.on("close", finish);

  runWithContext(ctx, () => next());
}
