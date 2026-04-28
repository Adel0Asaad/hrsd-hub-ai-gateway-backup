// ai-gateway/src/errors/index.ts
//
// A small, explicit error hierarchy. Every path that can fail in a way
// that must reach the client throws one of these. The global error
// handler converts them to a consistent wire envelope.
//
// Rules:
//   * Every error has a stable string `code` the frontend can key on.
//     Wire format changes are breaking — add new codes, don't rename.
//   * Messages are end-user-safe. We never leak upstream URLs, SQL
//     fragments, or raw LLM text.
//   * `statusCode` is the HTTP mapping. If absent, the handler falls
//     back to 500.
//   * `retryable` lets the frontend decide whether to show a retry
//     button without hard-coding a list of codes.

/* ------------------------------------------------------------------ */
/*  Error code catalogue                                               */
/* ------------------------------------------------------------------ */

export const ErrorCode = {
  // Client-side (4xx)
  INVALID_INPUT: "INVALID_INPUT",
  USER_ID_REQUIRED: "USER_ID_REQUIRED",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

  // Upstream/dependency (5xx)
  CHAT_CONTEXT_UNAVAILABLE: "CHAT_CONTEXT_UNAVAILABLE",
  LLM_UNAVAILABLE: "LLM_UNAVAILABLE",
  MCP_UNAVAILABLE: "MCP_UNAVAILABLE",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",

  // Internal (5xx)
  INTERNAL_ERROR: "INTERNAL_ERROR",
  MAX_ROUNDS_EXCEEDED: "MAX_ROUNDS_EXCEEDED",
  APP_ERROR: "APP_ERROR",
} as const;

export type ErrorCodeLiteral = (typeof ErrorCode)[keyof typeof ErrorCode];

/* ------------------------------------------------------------------ */
/*  Base error                                                         */
/* ------------------------------------------------------------------ */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCodeLiteral;
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    code: ErrorCodeLiteral = ErrorCode.APP_ERROR,
    opts: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = opts.retryable ?? statusCode >= 500;
    this.details = opts.details;
  }
}

/* ------------------------------------------------------------------ */
/*  Named subclasses for common failures                               */
/* ------------------------------------------------------------------ */

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, message, ErrorCode.INVALID_INPUT, { retryable: false, details });
    this.name = "ValidationError";
  }
}

export class UserNotFoundError extends AppError {
  constructor(userId: string) {
    super(
      404,
      `No chat-context found for user "${userId}".`,
      ErrorCode.USER_NOT_FOUND,
      { retryable: false },
    );
    this.name = "UserNotFoundError";
  }
}

export class ChatContextUnavailableError extends AppError {
  constructor(cause?: string) {
    super(
      503,
      "Your account service is temporarily unavailable. Please try again in a moment.",
      ErrorCode.CHAT_CONTEXT_UNAVAILABLE,
      { retryable: true, details: cause ? { cause } : undefined },
    );
    this.name = "ChatContextUnavailableError";
  }
}

export class LlmUnavailableError extends AppError {
  constructor(cause?: string) {
    super(
      503,
      "The assistant is temporarily unavailable. Please try again in a moment.",
      ErrorCode.LLM_UNAVAILABLE,
      { retryable: true, details: cause ? { cause } : undefined },
    );
    this.name = "LlmUnavailableError";
  }
}

export class McpUnavailableError extends AppError {
  constructor(cause?: string) {
    super(
      503,
      "Some tools the assistant uses are temporarily unavailable. It will try to answer without them.",
      ErrorCode.MCP_UNAVAILABLE,
      { retryable: true, details: cause ? { cause } : undefined },
    );
    this.name = "McpUnavailableError";
  }
}

export class UpstreamTimeoutError extends AppError {
  constructor(target: string) {
    super(
      504,
      "A request to a downstream service timed out. Please try again.",
      ErrorCode.UPSTREAM_TIMEOUT,
      { retryable: true, details: { target } },
    );
    this.name = "UpstreamTimeoutError";
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number, details?: Record<string, unknown>) {
    super(
      429,
      `You're making requests too quickly. Please wait ${retryAfterSeconds}s before retrying.`,
      ErrorCode.RATE_LIMITED,
      { retryable: true, details: { retryAfterSeconds, ...details } },
    );
    this.name = "RateLimitedError";
  }
}

export class MaxRoundsExceededError extends AppError {
  constructor(rounds: number) {
    super(
      500,
      "The assistant took too many steps without finishing. Please rephrase your request.",
      ErrorCode.MAX_ROUNDS_EXCEEDED,
      { retryable: false, details: { rounds } },
    );
    this.name = "MaxRoundsExceededError";
  }
}

/* ------------------------------------------------------------------ */
/*  Wire envelope                                                      */
/* ------------------------------------------------------------------ */

export interface ErrorEnvelope {
  error: {
    code: ErrorCodeLiteral;
    message: string;
    retryable: boolean;
    traceId: string;
    details?: Record<string, unknown>;
  };
}

export function toEnvelope(
  err: AppError,
  traceId: string,
): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      traceId,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
