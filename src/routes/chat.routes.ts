// ai-gateway/src/routes/chat.routes.ts
// HTTP routes for chat. Thin layer — all logic lives in the orchestrator.
//
// Two endpoints:
//   POST /chat         - non-streaming; returns full JSON response.
//   POST /chat/stream  - SSE stream of delta tokens + tool-lifecycle
//                        events, terminating with a `final` event
//                        carrying the full assistant turn + history.
//
// Why SSE and not WebSockets?
//   * One-way (server → client) token delivery fits SSE perfectly.
//   * SSE auto-reconnect is undesirable for chat — we explicitly
//     don't set Last-Event-ID handling because a re-run would spend
//     tokens twice. Clients that want to resume should re-POST.
//   * SSE runs over plain HTTP/1.1 + keep-alive, which every reverse
//     proxy / ingress handles without special configuration.
//
// Resource safety:
//   * Per-connection `AbortController` tied to `req.on("close")` so an
//     abandoned stream releases sdp/mcp/llm calls immediately.
//   * Heartbeat every 15s keeps idle proxies from killing the socket.
//   * Response-size cap: if the aggregated text grows past
//     `server.maxResponseBytes`, we emit an `error` event and close.

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";

import { ChatOrchestrator } from "../orchestrator/chat.orchestrator.js";
import type { ChatMessage } from "../llm/types.js";
import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { ValidationError, AppError, toEnvelope } from "../errors/index.js";

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */

export function createChatRouter(orchestrator: ChatOrchestrator): Router {
  const router = Router();

  router.post(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const { message, conversationId, history, userId } = parseBody(req);

      // Tie caller-lifecycle to a cancellation signal.
      //
      // We listen on `res` (not `req`) because `req.on("close")` is
      // unreliable in Node + Express: it can fire for reasons that
      // aren't a client disconnect (keep-alive socket transitions,
      // body-parser cleanup, HTTP/2 stream resets on some proxies).
      // Those spurious fires would abort the SDP fetch in single-digit
      // ms and surface as a fake "timeout".
      //
      // `res.on("close")` fires either when the client genuinely
      // disconnected before the response was sent, OR when the
      // response finished normally. The `writableEnded` gate filters
      // out the second case so we only abort on real disconnects.
      const controller = new AbortController();
      const onResClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", onResClose);

      try {
        const result = await orchestrator.chat({
          message,
          userId,
          history,
          signal: controller.signal,
        });

        res.json({
          conversationId: conversationId ?? undefined,
          text: result.text,
          history: result.history,
          toolsUsed: result.toolsUsed,
        });
      } finally {
        res.removeListener("close", onResClose);
      }
    }),
  );

  router.post(
    "/stream",
    asyncHandler(async (req: Request, res: Response) => {
      const { message, conversationId, history, userId } = parseBody(req);

      // --- SSE preamble ---
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // disable nginx buffering
      });
      // Flush headers immediately so the client sees the stream open.
      // `res.flushHeaders` is a no-op on Node 18+ but stays safe to call.
      res.flushHeaders?.();

      // Use res.on("close") for the same reason as the non-streaming
      // endpoint — req.on("close") fires for too many benign reasons
      // and would prematurely abort the stream. The `writableEnded`
      // gate is omitted here because SSE keeps the response open for
      // the duration of the stream, so any close event during
      // streaming really does mean the client went away.
      const controller = new AbortController();
      const closeListener = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", closeListener);

      // Heartbeat keeps intermediate proxies from closing the idle TCP
      // connection mid-stream. Unref so it doesn't keep the event loop
      // alive past shutdown.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(`: keep-alive\n\n`);
      }, 15_000);
      heartbeat.unref?.();

      const send = (event: string, data: unknown): void => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      if (conversationId) {
        send("meta", { conversationId });
      }

      let bytesEmitted = 0;
      const maxBytes = config.server.maxResponseBytes;
      let capped = false;

      try {
        for await (const ev of orchestrator.stream({
          message,
          userId,
          history,
          signal: controller.signal,
        })) {
          if (ev.type === "delta") {
            bytesEmitted += Buffer.byteLength(ev.text, "utf8");
            if (bytesEmitted > maxBytes) {
              capped = true;
              send("error", {
                error: {
                  code: "PAYLOAD_TOO_LARGE",
                  message:
                    "Response exceeded the server's maximum size budget. Closing stream.",
                  retryable: false,
                },
              });
              break;
            }
            send("delta", { text: ev.text });
          } else if (ev.type === "tool_start") {
            send("tool_start", { id: ev.id, name: ev.name });
          } else if (ev.type === "tool_end") {
            send("tool_end", {
              id: ev.id,
              name: ev.name,
              durationMs: ev.durationMs,
              isError: ev.isError,
            });
          } else if (ev.type === "final") {
            send("final", {
              text: ev.text,
              history: ev.history,
              toolsUsed: ev.toolsUsed,
            });
          } else if (ev.type === "error") {
            const traceId = (req as Request & { traceId?: string }).traceId ?? "";
            send("error", toEnvelope(ev.error, traceId));
          }
        }
      } catch (err) {
        logger.error(
          { err: (err as Error)?.message, stack: (err as Error)?.stack },
          "chat_stream_failed",
        );
        const appErr =
          err instanceof AppError
            ? err
            : new AppError(500, "Internal streaming error.", "INTERNAL_ERROR");
        const traceId = (req as Request & { traceId?: string }).traceId ?? "";
        send("error", toEnvelope(appErr, traceId));
      } finally {
        clearInterval(heartbeat);
        res.removeListener("close", closeListener);
        if (!res.writableEnded) {
          if (!capped) send("done", { ok: true });
          res.end();
        }
      }
    }),
  );

  return router;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function parseBody(req: Request): {
  message: string;
  userId: string;
  conversationId?: string;
  history?: ChatMessage[];
} {
  const { message, conversationId, history, userId } = req.body as {
    message?: string;
    conversationId?: string;
    history?: ChatMessage[];
    userId?: string;
  };

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    throw new ValidationError('"message" is required and must be a non-empty string.');
  }
  if (!userId || typeof userId !== "string" || userId.trim().length === 0) {
    throw new ValidationError('"userId" is required and must be a non-empty string.');
  }
  if (history !== undefined) {
    if (!Array.isArray(history)) {
      throw new ValidationError('"history" must be an array of ChatMessage objects.');
    }
    for (const msg of history) {
      if (!msg || typeof msg !== "object" || !msg.role || msg.content === undefined) {
        throw new ValidationError('Each history message must have "role" and "content".');
      }
    }
  }
  return { message: message.trim(), userId: userId.trim(), conversationId, history };
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
