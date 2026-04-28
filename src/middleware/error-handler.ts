// ai-gateway/src/middleware/error-handler.ts
//
// Terminal Express middleware. Converts any error reaching it into the
// uniform `ErrorEnvelope` shape defined in src/errors. Every wire
// response carries `{ error: { code, message, retryable, traceId } }`
// so the frontend can branch deterministically.
//
// This file re-exports the error classes for backwards compatibility
// with code that still imports `AppError` from here.

import type { Request, Response, NextFunction } from "express";

import {
  AppError,
  ErrorCode,
  toEnvelope,
  type ErrorEnvelope,
} from "../errors/index.js";
import { logger, serializeHttpError } from "../observability/logger.js";

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const traceId = req.traceId ?? req.correlationId ?? "unknown";

  // If headers already flushed (streaming response partway through),
  // Express requires we delegate — the connection will be closed by
  // the transport. We still log the cause for postmortem.
  if (res.headersSent) {
    logger.error(
      { traceId, err: serializeHttpError(err) },
      "error_after_response_sent",
    );
    try {
      res.end();
    } catch {
      /* already dead */
    }
    return;
  }

  // Known application error — pass through with its code + status.
  if (err instanceof AppError) {
    // 4xx → warn (caller's fault), 5xx → error (ours/upstream).
    const level = err.statusCode >= 500 ? "error" : "warn";
    logger[level](
      { traceId, code: err.code, status: err.statusCode },
      err.message,
    );
    const envelope: ErrorEnvelope = toEnvelope(err, traceId);
    res.status(err.statusCode).json(envelope);
    return;
  }

  // Unknown error — assume server fault, never leak the stack/message.
  logger.error(
    { traceId, err: serializeHttpError(err) },
    "unhandled_error",
  );

  const envelope: ErrorEnvelope = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: "An unexpected error occurred. Please try again later.",
      retryable: true,
      traceId,
    },
  };
  res.status(500).json(envelope);
}

// Re-exports so existing imports keep working during the transition.
export { AppError } from "../errors/index.js";
