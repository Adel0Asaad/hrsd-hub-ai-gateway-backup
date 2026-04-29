// ai-gateway/src/llm/factory.ts
//
// Config-driven factory that creates the active LLM provider.
// Adding a provider = one new file + one entry here.

import { getActiveProviderConfig, config } from "../config/env.js";
import type { ProviderConfig } from "../config/env.js";
import type { LlmProvider } from "./types.js";
import { OpenAIProvider } from "./openai.provider.js";
import { OciProvider } from "./oci.provider.js";
import { logger } from "../observability/logger.js";

type ProviderFactory = (cfg: ProviderConfig) => LlmProvider;

const registry: Record<string, ProviderFactory> = {
  openai: (cfg) =>
    new OpenAIProvider({
      apiKey: cfg.apiKey,
      model: cfg.model,
      timeoutMs: config.llm.timeoutMs,
      maxRetries: config.llm.maxRetries,
      circuitBreakerThreshold: config.llm.circuitBreakerThreshold,
      circuitBreakerResetMs: config.llm.circuitBreakerResetMs,
    }),
  ollama: (cfg) =>
    new OpenAIProvider({
      apiKey: cfg.apiKey || 'ollama',
      model: cfg.model,
      baseURL: cfg.baseURL,
      timeoutMs: config.llm.timeoutMs,
      maxRetries: config.llm.maxRetries,
      circuitBreakerThreshold: config.llm.circuitBreakerThreshold,
      circuitBreakerResetMs: config.llm.circuitBreakerResetMs,
    }),
  oci: () => new OciProvider(config),
  // Add more providers here when needed.
};

let instance: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (instance) return instance;

  const active = getActiveProviderConfig();
  const factory = registry[active.name];
  if (!factory) {
    const available = Object.keys(registry).join(", ");
    throw new Error(
      `No factory registered for LLM provider "${active.name}". ` +
        `Registered: ${available}.`,
    );
  }
  instance = factory(active as ProviderConfig);
  const modelInfo = 'model' in active ? active.model : 'N/A';
  logger.info(
    { provider: instance.name, model: modelInfo },
    "llm_provider_initialised",
  );
  return instance;
}
