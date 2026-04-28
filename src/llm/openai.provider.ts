// ai-gateway/src/llm/openai.provider.ts
//
// OpenAI Chat Completions implementation of LlmProvider.
//
// Behaviours added for production:
//   * Per-call AbortSignal propagation (client disconnects release
//     the upstream connection immediately).
//   * Retry on transient 5xx/429 with exponential backoff.
//   * Circuit breaker around the outgoing HTTP call so a dead
//     provider doesn't drown the event loop.
//   * Streaming variant that yields token deltas + a single
//     assembled tool-calls event per turn.

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions.js";

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  ToolDefinition,
  ChatMessage,
  AssistantToolCall,
  ToolCall,
} from "./types.js";
import {
  CircuitBreaker,
  CircuitOpenError,
} from "../resilience/circuit-breaker.js";
import { retry } from "../resilience/retry.js";
import {
  linkSignals,
  timeoutSignal,
  isAbortError,
} from "../resilience/timeout.js";
import { LlmUnavailableError, UpstreamTimeoutError } from "../errors/index.js";
import { logger } from "../observability/logger.js";
import { circuitBreakerState } from "../observability/metrics.js";

export interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
}

export class OpenAIProvider implements LlmProvider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly breaker: CircuitBreaker;

  constructor(cfg: OpenAIProviderConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey });
    this.model = cfg.model;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.maxRetries = cfg.maxRetries ?? 2;
    this.breaker = new CircuitBreaker({
      failureThreshold: cfg.circuitBreakerThreshold ?? 5,
      resetAfterMs: cfg.circuitBreakerResetMs ?? 30_000,
      onStateChange: (state, reason) => {
        logger.warn({ state, reason }, "llm_circuit_state_change");
        // Gauge values: closed=0, half-open=1, open=2 — ordered by
        // severity so alerts can trigger on `>= 1`.
        const v = state === "closed" ? 0 : state === "half-open" ? 1 : 2;
        circuitBreakerState.labels("llm").set(v);
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Non-streaming                                                   */
  /* ---------------------------------------------------------------- */

  async chat(request: LlmRequest): Promise<LlmResponse> {
    const messages = request.messages.map(toOpenAIMessage);
    const tools =
      request.tools.length > 0 ? request.tools.map(toOpenAITool) : undefined;

    const run = async (): Promise<LlmResponse> => {
      const signal = linkSignals(request.signal, timeoutSignal(this.timeoutMs));
      let completion;
      try {
        completion = await this.client.chat.completions.create(
          {
            model: this.model,
            messages,
            tools,
            tool_choice: tools ? "auto" : undefined,
          },
          { signal },
        );
      } catch (err) {
        if (isAbortError(err)) {
          // Client disconnect vs. deadline — caller sees abort; we map
          // deadline specifically.
          if (request.signal?.aborted) throw err;
          throw new UpstreamTimeoutError("llm");
        }
        throw err;
      }

      const choice = completion.choices[0];
      if (!choice) return { text: "" };
      const msg = choice.message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const assistantToolCalls: AssistantToolCall[] = msg.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));
        return {
          toolCalls: msg.tool_calls.map(mapToolCall),
          meta: {
            assistantMessage: {
              role: "assistant" as const,
              content: msg.content ?? "",
              toolCalls: assistantToolCalls,
            } satisfies ChatMessage,
          },
        };
      }

      return { text: msg.content ?? "" };
    };

    return this.breaker.exec(() =>
      retry(run, {
        retries: this.maxRetries,
        baseDelayMs: 300,
        maxDelayMs: 2_000,
        signal: request.signal,
      }),
    ).catch((err) => {
      if (err instanceof CircuitOpenError) {
        throw new LlmUnavailableError("circuit_open");
      }
      throw err;
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Streaming                                                       */
  /* ---------------------------------------------------------------- */

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const messages = request.messages.map(toOpenAIMessage);
    const tools =
      request.tools.length > 0 ? request.tools.map(toOpenAITool) : undefined;

    // Streaming bypasses retry — token streams aren't safely resumable.
    // The breaker is still engaged so a dead provider fails fast.
    let stream;
    try {
      stream = await this.breaker.exec(() =>
        this.client.chat.completions.create(
          {
            model: this.model,
            messages,
            tools,
            tool_choice: tools ? "auto" : undefined,
            stream: true,
          },
          {
            signal: linkSignals(request.signal, timeoutSignal(this.timeoutMs)),
          },
        ),
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        yield { type: "error", error: new LlmUnavailableError("circuit_open") };
        return;
      }
      if (isAbortError(err)) {
        yield { type: "error", error: new UpstreamTimeoutError("llm") };
        return;
      }
      yield { type: "error", error: err as Error };
      return;
    }

    // Buffer state for this turn.
    let text = "";
    // tool_calls come in piecewise — we assemble by index.
    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    try {
      for await (const chunk of stream as AsyncIterable<any>) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};

        if (typeof delta.content === "string" && delta.content.length > 0) {
          text += delta.content;
          yield { type: "delta", text: delta.content };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) {
            const idx = part.index ?? 0;
            const acc = toolCallAccumulators.get(idx) ?? { id: "", name: "", args: "" };
            if (part.id) acc.id = part.id;
            if (part.function?.name) acc.name = part.function.name;
            if (part.function?.arguments) acc.args += part.function.arguments;
            toolCallAccumulators.set(idx, acc);
          }
        }

        if (choice.finish_reason) break;
      }
    } catch (err) {
      if (isAbortError(err)) {
        // Client or deadline aborted mid-stream — not a provider fault.
        yield { type: "error", error: err as Error };
        return;
      }
      yield { type: "error", error: err as Error };
      return;
    }

    // If the model called tools, emit a single tool_calls event with
    // the fully assembled descriptors and the matching assistant message.
    if (toolCallAccumulators.size > 0) {
      const sorted = [...toolCallAccumulators.entries()].sort((a, b) => a[0] - b[0]);
      const toolCalls: ToolCall[] = sorted.map(([, acc]) => ({
        id: acc.id,
        name: acc.name,
        arguments: safeParseJson(acc.args),
      }));
      const assistantToolCalls: AssistantToolCall[] = sorted.map(([, acc]) => ({
        id: acc.id,
        name: acc.name,
        arguments: acc.args,
      }));
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: text,
        toolCalls: assistantToolCalls,
      };
      yield { type: "tool_calls", toolCalls, assistantMessage };
      return;
    }

    yield { type: "done", text };
  }
}

/* ------------------------------------------------------------------ */
/*  Mapping helpers (exported for unit tests)                          */
/* ------------------------------------------------------------------ */

export function toOpenAIMessage(msg: ChatMessage): ChatCompletionMessageParam {
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content };
    case "user":
      return { role: "user", content: msg.content };
    case "assistant": {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: msg.content ?? "",
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: "assistant", content: msg.content ?? "" };
    }
    case "tool":
      return {
        role: "tool",
        content: msg.content,
        tool_call_id: msg.toolCallId!,
      };
    default:
      return { role: "user", content: msg.content };
  }
}

export function toOpenAITool(def: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters as Record<string, unknown>,
    },
  };
}

export function mapToolCall(tc: ChatCompletionMessageToolCall): ToolCall {
  return {
    id: tc.id,
    name: tc.function.name,
    arguments: safeParseJson(tc.function.arguments),
  };
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
