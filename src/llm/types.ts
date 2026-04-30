// ai-gateway/src/llm/types.ts
//
// Provider-agnostic contracts for the LLM abstraction layer.
// Any new provider (Gemini, Claude, Groq, …) implements these.

/* ------------------------------------------------------------------ */
/*  Tool definitions (JSON Schema subset)                              */
/* ------------------------------------------------------------------ */

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

/**
 * UI-rendering hint forwarded by the MCP server under the tool's
 * `_meta.render` field. Lets the orchestrator decorate the final text
 * (e.g. with a ```cards fenced block) purely based on spec metadata —
 * no tool-name branching in the orchestrator.
 *
 * `kind` is opaque to the gateway; the frontend routes on it. Current
 * kinds: "gallery".
 */
export interface ToolRenderHint {
  kind: string;
  /** Field name on each list entry that maps to the card `code`. Default "code". */
  itemCode?: string;
  /** Field name on each list entry that maps to the card `name`. Default "name". */
  itemName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  /**
   * Optional UI-rendering hint. Gateway-internal; never forwarded to
   * the LLM (providers strip unknown fields and we only include
   * `name/description/parameters` in the wire payload anyway).
   */
  render?: ToolRenderHint;
}

/* ------------------------------------------------------------------ */
/*  Messages                                                           */
/* ------------------------------------------------------------------ */

export interface AssistantToolCall {
  id: string;
  name: string;
  /** Stringified JSON payload exactly as produced by the LLM. */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: AssistantToolCall[];
}

/* ------------------------------------------------------------------ */
/*  Tool calls (returned when the LLM wants to invoke a tool)          */
/* ------------------------------------------------------------------ */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Non-streaming request / response                                   */
/* ------------------------------------------------------------------ */

export interface LlmResponse {
  text?: string;
  toolCalls?: ToolCall[];
  meta?: Record<string, unknown>;
}

export interface LlmRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  meta?: Record<string, unknown>;
  /** Aborts the provider request when the caller disconnects. */
  signal?: AbortSignal;
  /** 
   * Previous LLM response from the last round. 
   * Providers can extract provider-specific state (like OCI's chatHistory) 
   * from meta and reuse it directly instead of re-parsing messages.
   */
  previousResponse?: LlmResponse;
}

/* ------------------------------------------------------------------ */
/*  Streaming events                                                   */
/* ------------------------------------------------------------------ */

/**
 * Stream events emitted as the provider generates its response.
 *
 * `delta` carries incremental text tokens. `tool_calls` carries the
 * final assembled tool-call descriptors for this turn (OpenAI emits
 * tool-call arguments character by character; we buffer them and emit
 * a single `tool_calls` event rather than a partial JSON stream to
 * keep the orchestrator simple).
 *
 * `done` marks the end of the turn; `error` aborts it.
 */
export type LlmStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; toolCalls: ToolCall[]; assistantMessage: ChatMessage }
  | { type: "done"; text: string }
  | { type: "error"; error: Error };

/* ------------------------------------------------------------------ */
/*  Provider contract                                                  */
/* ------------------------------------------------------------------ */

export interface LlmProvider {
  readonly name: string;
  chat(request: LlmRequest): Promise<LlmResponse>;
  /**
   * Streaming variant. Optional — providers without native streaming
   * can leave this unimplemented and the orchestrator falls back to
   * chat() for those cases.
   */
  stream?(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}
