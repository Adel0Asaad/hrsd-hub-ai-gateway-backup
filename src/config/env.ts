// ai-gateway/src/config/env.ts
//
// Loads gateway.config.json (or falls back to env vars), interpolates
// ${ENV_VAR} tokens, then hands the result to zod for strict
// validation. A malformed config is fatal at boot.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  gatewayConfigSchema,
  type GatewayConfig,
  type ProviderConfig,
  type OciProviderConfig,
} from "./schema.js";

/* ------------------------------------------------------------------ */
/*  Env-var interpolation                                              */
/* ------------------------------------------------------------------ */

/**
 * Replaces `${VAR_NAME}` tokens in a string with the corresponding
 * process.env value. Leaves the token as-is when the env var is unset —
 * the zod layer surfaces it as a validation error at boot so nothing
 * half-configured can reach production.
 */
function interpolate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      return process.env[varName] ?? match;
    });
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolate(v);
    }
    return result;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/*  Defaults for env-var-only mode                                     */
/* ------------------------------------------------------------------ */

function envOnlyConfig(): unknown {
  const FIVE_MIN = 5 * 60 * 1000;
  const ONE_MIN = 60 * 1000;
  return {
    llm: {
      provider: process.env.LLM_PROVIDER ?? "openai",
      providers: {
        openai: {
          apiKey: process.env.OPENAI_API_KEY ?? "",
          model: process.env.OPENAI_MODEL ?? "gpt-4.1",
        },
      },
    },
    mcp: {
      serverUrl: process.env.MCP_SERVER_URL ?? "http://localhost:3001/mcp",
    },
    sdpService: {
      baseUrl: process.env.SDP_SERVICE_URL ?? "http://localhost:8080",
    },
    server: {
      port: Number(process.env.PORT ?? 3002),
      logLevel: process.env.LOG_LEVEL ?? "info",
      allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    rateLimits: {
      default: { windowMs: ONE_MIN, maxCalls: 20 },
      perTool: {
        create_parking_card: { windowMs: FIVE_MIN, maxCalls: 1 },
        submit_medical_device_aid_request: { windowMs: FIVE_MIN, maxCalls: 1 },
        request_house_maid: { windowMs: FIVE_MIN, maxCalls: 1 },
        request_home_checkup: { windowMs: FIVE_MIN, maxCalls: 1 },
      },
      cleanupIntervalMs: ONE_MIN,
    },
    cache: {
      redis: {
        enabled: (process.env.REDIS_ENABLED ?? "false").toLowerCase() === "true",
        url: process.env.REDIS_URL,
        keyPrefix: process.env.REDIS_KEY_PREFIX ?? "aigw:",
      },
    },
    metrics: {
      enabled: (process.env.METRICS_ENABLED ?? "true").toLowerCase() === "true",
      accessLogSampling: Number(process.env.ACCESS_LOG_SAMPLING ?? 1.0),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Load + validate                                                    */
/* ------------------------------------------------------------------ */

function loadRaw(): unknown {
  const configPath = resolve(
    process.env.GATEWAY_CONFIG_PATH ?? "gateway.config.json",
  );
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    return interpolate(JSON.parse(raw));
  }
  return interpolate(envOnlyConfig());
}

function loadConfig(): GatewayConfig {
  const raw = loadRaw();
  const parsed = gatewayConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // Print every validation issue and exit — there is no recovering
    // from an invalid config and silent defaults mask production bugs.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(
      `Invalid gateway configuration:\n${issues}\n\n` +
        "Fix gateway.config.json or the corresponding environment variables.",
    );
    process.exit(1);
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export const config: GatewayConfig = Object.freeze(loadConfig());

/**
 * Look up the active provider config, with explicit errors if misset.
 * Kept separate from the zod layer because the provider key is dynamic.
 */
export function getActiveProviderConfig(): { name: string } & (ProviderConfig | OciProviderConfig) {
  const name = config.llm.provider;
  const providerConfig = config.llm.providers[name];
  if (!providerConfig) {
    const available = Object.keys(config.llm.providers).join(", ");
    throw new Error(
      `Unknown LLM provider "${name}" in config. Available: ${available}`,
    );
  }
  // Only require apiKey for providers that use it (not OCI)
  if ("apiKey" in providerConfig && ["openai", "gemini", "claude", "ollama"].includes(name)) {
    if (!providerConfig.apiKey || providerConfig.apiKey.startsWith("${")) {
      throw new Error(
        `API key for provider "${name}" is not set. ` +
          `Set the corresponding environment variable (e.g. OPENAI_API_KEY).`,
      );
    }
  }
  return { name, ...providerConfig } as { name: string } & (ProviderConfig | OciProviderConfig);
}

// Re-export config types for convenience.
export type { GatewayConfig, ProviderConfig, OciProviderConfig, OciAuthConfig, OciChatConfig } from "./schema.js";
