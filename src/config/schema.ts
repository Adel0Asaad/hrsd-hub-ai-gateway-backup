// ai-gateway/src/config/schema.ts
//
// Single source of truth for config shape — parsed with zod at boot so
// we fail loudly and immediately if the operator mis-configured the
// service. Invalid config at startup is preferable to a cryptic
// "undefined is not a function" on first request.

import { z } from "zod";

/* ------------------------------------------------------------------ */
/*  Sub-schemas                                                        */
/* ------------------------------------------------------------------ */

const rateLimitRuleSchema = z.object({
  windowMs: z.number().int().positive(),
  maxCalls: z.number().int().positive(),
});

const rateLimitsSchema = z.object({
  default: rateLimitRuleSchema,
  perTool: z.record(z.string(), rateLimitRuleSchema).optional(),
  cleanupIntervalMs: z.number().int().nonnegative().optional(),
});

const providerConfigSchema = z
  .object({
    apiKey: z.string().min(1, "apiKey cannot be empty"),
    model: z.string().min(1),
  })
  .catchall(z.unknown());

const ociAuthConfigSchema = z.object({
  url: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  grantType: z.string().min(1),
  rejectUnauthorized: z.boolean().optional(),
});

const ociChatConfigSchema = z.object({
  url: z.string().url(),
  compartmentId: z.string().min(1),
  servingType: z.string().min(1),
  endpointId: z.string().min(1),
  apiFormat: z.string().min(1),
  rejectUnauthorized: z.boolean().optional(),
});

const ociProviderConfigSchema = z.object({
  auth: ociAuthConfigSchema,
  chat: ociChatConfigSchema,
});

const llmSchema = z.object({
  provider: z.string().min(1),
  providers: z.record(z.string(), providerConfigSchema.or(ociProviderConfigSchema)),
  // Per-call timeout on outgoing LLM requests in ms.
  timeoutMs: z.number().int().positive().default(30_000),
  // Retry on transient errors (5xx / 429). 0 disables retry.
  maxRetries: z.number().int().nonnegative().default(2),
  // Circuit breaker: consecutive failures before we open the circuit.
  circuitBreakerThreshold: z.number().int().positive().default(5),
  // Circuit cool-down before we test the provider again.
  circuitBreakerResetMs: z.number().int().positive().default(30_000),
});

/**
 * Operator-supplied render hint keyed by tool name. Used only when the
 * MCP server doesn't advertise an `_meta.render` for that tool — this
 * lets the gallery work even if the backend OpenAPI spec hasn't been
 * annotated yet (or is still on an older build). Upstream hints always
 * win over overrides, so adding the backend annotation later is a
 * no-op change from the client's point of view.
 */
const toolRenderOverrideSchema = z.object({
  kind: z.string().min(1),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
});

const mcpSchema = z.object({
  serverUrl: z.string().url(),
  timeoutMs: z.number().int().positive().default(10_000),
  // If MCP is unreachable, continue without tools (text-only degraded mode).
  // When false, a dead MCP server is a hard error.
  degradeGracefully: z.boolean().default(true),
  /**
   * Name → render-hint fallback. Leave empty in production once the
   * backend OpenAPI spec carries `x-mcp-tool.render`.
   */
  toolRenderOverrides: z.record(z.string(), toolRenderOverrideSchema).default({}),
});

const sdpServiceSchema = z.object({
  baseUrl: z.string().url(),
  timeoutMs: z.number().int().positive().default(3_000),
  // Cache TTL for chat-context bundles to take pressure off sdp-service.
  // 0 disables caching.
  contextCacheTtlMs: z.number().int().nonnegative().default(60_000),
});

const serverSchema = z.object({
  port: z.number().int().positive().default(3002),
  logLevel: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  allowedOrigins: z.array(z.string()).default([]),
  // Hard cap on JSON body size for /chat. Protects against memory-DoS.
  maxBodyBytes: z.number().int().positive().default(256 * 1024),
  // Maximum bytes of content produced by a single assistant turn. Hard
  // cap — streams are aborted and a friendly error is returned if
  // exceeded. Protects against runaway LLM output.
  maxResponseBytes: z.number().int().positive().default(256 * 1024),
  // Per-request total budget in ms. After this, in-flight downstream
  // calls are cancelled via abort signal.
  requestTimeoutMs: z.number().int().positive().default(60_000),
});

const cacheSchema = z.object({
  redis: z.object({
    enabled: z.boolean().default(false),
    url: z.string().url().optional(),
    keyPrefix: z.string().default("aigw:"),
  }),
});

const metricsSchema = z.object({
  enabled: z.boolean().default(true),
  // Sample rate for access logs — 1.0 logs every request, 0.1 logs 10%.
  accessLogSampling: z.number().min(0).max(1).default(1.0),
});

/* ------------------------------------------------------------------ */
/*  Root schema                                                        */
/* ------------------------------------------------------------------ */

export const gatewayConfigSchema = z.object({
  llm: llmSchema,
  mcp: mcpSchema,
  sdpService: sdpServiceSchema,
  server: serverSchema,
  rateLimits: rateLimitsSchema,
  cache: cacheSchema.default({ redis: { enabled: false, keyPrefix: "aigw:" } }),
  metrics: metricsSchema.default({ enabled: true, accessLogSampling: 1.0 }),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type LlmConfig = z.infer<typeof llmSchema>;
export type McpConfig = z.infer<typeof mcpSchema>;
export type SdpServiceConfig = z.infer<typeof sdpServiceSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type CacheConfig = z.infer<typeof cacheSchema>;
export type MetricsConfig = z.infer<typeof metricsSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type OciProviderConfig = z.infer<typeof ociProviderConfigSchema>;
export type OciAuthConfig = z.infer<typeof ociAuthConfigSchema>;
export type OciChatConfig = z.infer<typeof ociChatConfigSchema>;
export type RateLimitsConfig = z.infer<typeof rateLimitsSchema>;
