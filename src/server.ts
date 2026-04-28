// ai-gateway/src/server.ts
// Application entry point. Wires up all layers and starts the HTTP server.
//
// Boot sequence:
//   1. Validate config (happens at import time in ./config/env.ts).
//   2. Initialise the KV store — Redis if `cache.redis.enabled`,
//      otherwise in-process.
//   3. Build LLM, MCP, rate-limiter, sdp-fetcher, orchestrator.
//   4. Mount middleware in the canonical order: CORS → body parser →
//      request logger → routes → error handler.
//   5. Start listening.
//   6. Wire graceful-shutdown on SIGINT / SIGTERM so in-flight chats
//      finish and connections to Redis/MCP are closed cleanly.

// ⚠️ DEVELOPMENT ONLY: Disable SSL certificate verification
// This is required for OCI API calls in development/staging environments
// DO NOT use in production!
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import express from "express";
import cors from "cors";
import helmet from "helmet";

import { config } from "./config/env.js";
import { requestLogger } from "./middleware/request-logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { logger } from "./observability/logger.js";
import { registry as metricsRegistry } from "./observability/metrics.js";
import { getLlmProvider } from "./llm/factory.js";
import { McpClientService } from "./mcp/client.js";
import { ChatOrchestrator } from "./orchestrator/chat.orchestrator.js";
import { createChatRouter } from "./routes/chat.routes.js";
import { RateLimiter } from "./orchestrator/rate-limiter.js";
import { HttpChatContextFetcher } from "./sdp/client.js";
import { getKeyValueStore, disposeKeyValueStore } from "./kv/factory.js";

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                         */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const app = express();

  // --- Global middleware ---
  // helmet sets a sensible baseline of security headers. We disable
  // the CSP header entirely because the gateway is a JSON API — the
  // frontend sets its own CSP and we don't serve HTML from here.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.disable("x-powered-by");

  const allowedOrigins = new Set(config.server.allowedOrigins);
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        return callback(new Error(`Origin "${origin}" is not allowed by CORS.`));
      },
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "x-trace-id"],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: `${config.server.maxBodyBytes}b` }));
  app.use(requestLogger);

  // --- Dependency wiring ---
  const kv = await getKeyValueStore();
  const llm = getLlmProvider();
  const mcp = new McpClientService();
  const rateLimiter = new RateLimiter(kv, config.rateLimits);
  const contextFetcher = new HttpChatContextFetcher();
  const orchestrator = new ChatOrchestrator(
    llm,
    mcp,
    rateLimiter,
    contextFetcher,
  );

  // --- Routes ---
  app.use("/chat", createChatRouter(orchestrator));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, provider: llm.name });
  });

  if (config.metrics.enabled) {
    app.get("/metrics", async (_req, res) => {
      try {
        res.setHeader("Content-Type", metricsRegistry.contentType);
        res.end(await metricsRegistry.metrics());
      } catch (err) {
        logger.warn({ err: (err as Error)?.message }, "metrics_scrape_error");
        res.status(500).end();
      }
    });
  }

  app.get("/health/ready", async (_req, res) => {
    // Minimal readiness: KV store reachable. MCP / LLM readiness is
    // intentionally NOT checked here because their degraded modes let
    // the gateway stay serving.
    try {
      await kv.set("health:probe", "1", 5_000);
      res.json({ ready: true });
    } catch (err) {
      res.status(503).json({
        ready: false,
        reason: (err as Error)?.message ?? "unknown",
      });
    }
  });

  // --- Global error handler (must be last) ---
  app.use(errorHandler);

  /* ---------------------------------------------------------------- */
  /*  Start                                                            */
  /* ---------------------------------------------------------------- */

  const server = app.listen(config.server.port, () => {
    logger.info(
      {
        port: config.server.port,
        provider: llm.name,
        mcpUrl: config.mcp.serverUrl,
        sdpUrl: config.sdpService.baseUrl,
        redis: config.cache.redis.enabled,
      },
      "gateway_listening",
    );
  });

  // Keep-alive & headers timeouts: set explicitly so the gateway won't
  // hold dead sockets open forever behind a load balancer.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  /* ---------------------------------------------------------------- */
  /*  Graceful shutdown                                                */
  /* ---------------------------------------------------------------- */

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "gateway_shutdown_begin");

    // Stop accepting new connections.
    server.close((err) => {
      if (err) logger.warn({ err: err.message }, "server_close_error");
    });

    // Best-effort cleanup with a short ceiling.
    const deadline = new Promise<void>((resolve) =>
      setTimeout(resolve, 10_000).unref(),
    );
    await Promise.race([
      (async () => {
        rateLimiter.dispose();
        await mcp.disconnect();
        await disposeKeyValueStore();
      })(),
      deadline,
    ]);

    logger.info("gateway_shutdown_complete");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Last-resort handlers — never swallow silently.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, "uncaught_exception");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(
      { reason: reason instanceof Error ? reason.message : String(reason) },
      "unhandled_rejection",
    );
  });
}

main().catch((err) => {
  logger.fatal(
    { err: (err as Error)?.message, stack: (err as Error)?.stack },
    "gateway_boot_failed",
  );
  process.exit(1);
});
