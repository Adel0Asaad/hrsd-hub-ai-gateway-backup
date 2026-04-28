// ai-gateway/src/orchestrator/chat.orchestrator.ts
// The central orchestration loop.
//
// Responsibilities (post-hardening):
//   1. Require a verified userId on every call.
//   2. Fetch the chat-context bundle from sdp-service — a ready-to-use
//      system prompt + MCP tool allowlist composed server-side.
//   3. Inject the bundle's systemPrompt verbatim on the first turn.
//   4. Load tools from MCP, intersect with the bundle's allowlist, send
//      to the LLM. If MCP is degraded (empty tool list), append a short
//      advisory to the system prompt so the LLM answers text-only
//      instead of hallucinating tool names.
//   5. On tool calls: check the allowlist, enforce rate limits, execute,
//      TOON-encode the result, feed back.
//   6. Loop until the LLM produces a final text response or the round
//      cap is reached.
//
// Hardening added in the production-ready pass:
//   * AbortSignal propagation end-to-end — if the HTTP request is
//     aborted by the client, sdp/mcp/llm calls in flight are cancelled
//     immediately. No orphaned work, no resource leaks.
//   * Typed error hierarchy — every failure mode maps to an AppError
//     subclass with a stable code the frontend can switch on.
//   * Graceful MCP degradation — if MCP is down and the config permits
//     it, answer text-only rather than erroring.
//   * Streaming variant (`stream()`) that emits SSE-ready events
//     without losing any of the above guarantees.

import type {
  LlmProvider,
  LlmStreamEvent,
  ChatMessage,
  LlmResponse,
  ToolDefinition,
  ToolCall,
  ToolRenderHint,
} from "../llm/types.js";
import type { McpClientService, ToolResult } from "../mcp/client.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { ChatContextFetcher, ChatContextBundle } from "../sdp/client.js";
import { ChatContextFetchError } from "../sdp/client.js";
import { resultToToon } from "./toon.js";
import { logger } from "../observability/logger.js";
import { rateLimitBlockedTotal } from "../observability/metrics.js";
import {
  AppError,
  ChatContextUnavailableError,
  LlmUnavailableError,
  MaxRoundsExceededError,
  UpstreamTimeoutError,
  UserNotFoundError,
  ValidationError,
} from "../errors/index.js";
import { isAbortError } from "../resilience/timeout.js";

/* ------------------------------------------------------------------ */
/*  Configuration                                                     */
/* ------------------------------------------------------------------ */

/** Maximum tool-call round-trips before we force a text response. */
const MAX_TOOL_ROUNDS = 10;

/**
 * Appended to the system prompt when MCP is unreachable. Keeps the LLM
 * from inventing tool calls that will only bounce back as errors.
 */
const MCP_DEGRADED_NOTICE =
  "\n\nIMPORTANT: Backend tools are temporarily unavailable. " +
  "Answer the user in plain text. Do not claim to have executed any tool. " +
  "If the user is asking for a tool-only action, apologise briefly and ask them to retry in a moment.";

/**
 * Generic UI-rendering block we append to the final assistant text
 * whenever a tool whose spec carries `_meta.render` succeeds. The
 * block is purely additive — clients that don't understand it just
 * see a fenced code block, so it degrades gracefully.
 *
 * Spec-driven on purpose: the orchestrator has zero knowledge of any
 * specific tool (no `list_assistive_devices` branch, no `DeviceCard`
 * shape). Adding a second renderable tool is a backend-only change:
 *   1. Annotate the endpoint with `render: { kind, itemCode, itemName }`.
 *   2. Reload mcp-server.
 *   3. Done — the gateway passes the block through and the frontend
 *      routes on `kind`.
 *
 * Current supported kinds (frontend): "gallery".
 */
interface CardsBlock {
  kind: string;
  items: Array<{ code: string; name: string }>;
}

/**
 * Name of the fenced code block we emit to carry rendering payloads
 * through the plain-text chat transport. Kept generic so it's not
 * tied to any specific feature (the old `devices` fence was).
 */
const CARDS_FENCE = "cards";

/* ------------------------------------------------------------------ */
/*  Request / Response types                                          */
/* ------------------------------------------------------------------ */

export interface ChatRequest {
  /** The user's message. */
  message: string;
  /**
   * Verified user identifier set by the frontend after login. Required —
   * the orchestrator refuses to proceed without one because every piece
   * of policy (prompt, tools, rate limits) is keyed on a known user.
   */
  userId: string;
  /** Conversation history from previous turns (for multi-turn support). */
  history?: ChatMessage[];
  /**
   * File IDs from documents uploaded by the user (via /api/documents/upload).
   * The orchestrator auto-injects these into tool calls that expect document
   * parameters, so the LLM doesn't need to track IDs manually.
   */
  fileIds?: string[];
  /**
   * Caller-owned cancellation. Flows into every downstream call so that
   * a dropped client releases sdp/mcp/llm work immediately.
   */
  signal?: AbortSignal;
}

export interface ToolExecutionMeta {
  name: string;
  durationMs: number;
  isError: boolean;
}

export interface ChatResponse {
  /** The LLM's final text answer. */
  text: string;
  /** Updated conversation history to send in the next request. */
  history: ChatMessage[];
  /** Metadata about tool usage for observability. */
  toolsUsed: ToolExecutionMeta[];
}

/* ------------------------------------------------------------------ */
/*  Orchestrator                                                      */
/* ------------------------------------------------------------------ */

export class ChatOrchestrator {
  constructor(
    private readonly llm: LlmProvider,
    private readonly mcp: McpClientService,
    private readonly rateLimiter: RateLimiter,
    private readonly contextFetcher: ChatContextFetcher,
  ) {}

  /* ================================================================== */
  /*  Non-streaming                                                      */
  /* ================================================================== */

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { message, userId, signal, fileIds } = this.validate(request);
    const history = request.history ?? [];

    const context = await this.fetchContext(userId, signal);
    const { messages, tools, mcpDegraded } = await this.prepareTurn(
      context,
      message,
      history,
      signal,
    );

    const toolsUsed: ToolExecutionMeta[] = [];
    // Map tool-name → render hint for this turn's allowlist. Only tools
    // whose spec declared `render` via MCP `_meta.render` appear here;
    // `executeToolCall` looks up by name to decide whether to capture a
    // block. No hardcoded tool names — adding a new renderable tool is
    // a backend-only change.
    const renderByTool = buildRenderIndex(tools);
    // Captures renderable blocks produced by successful tool calls
    // during this turn. Blocks are appended verbatim to the final text
    // so the frontend can route on `kind`.
    const capturedBlocks: CardsBlock[] = [];
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      round++;

      let response: LlmResponse;
      try {
        response = await this.llm.chat({ messages, tools, signal });
      } catch (err) {
        throw this.mapLlmError(err);
      }

      // 5a. Final text — we're done.
      if (
        (response.text !== undefined && !response.toolCalls?.length) ||
        !response.toolCalls ||
        response.toolCalls.length === 0
      ) {
        const finalText = appendCardsBlocks(response.text ?? "", capturedBlocks);
        messages.push({ role: "assistant", content: finalText });
        return { text: finalText, history: messages, toolsUsed };
      }

      // 5b. Tool calls. Append the assistant's tool-call message first.
      messages.push(this.assistantToolCallMessage(response));

      for (const toolCall of response.toolCalls) {
        const { meta, cards } = await this.executeToolCall({
          toolCall,
          userId,
          allowed: new Set(context.tools),
          renderByTool,
          messages,
          mcpDegraded,
          fileIds,
          signal,
        });
        toolsUsed.push(meta);
        if (cards) capturedBlocks.push(cards);
      }
    }

    throw new MaxRoundsExceededError(MAX_TOOL_ROUNDS);
  }

  /* ================================================================== */
  /*  Streaming                                                          */
  /* ================================================================== */

  /**
   * Streaming variant. Yields SSE-ready events that the HTTP layer
   * pipes to the client:
   *
   *   { type: "context_ready", bundle }         - context bundle resolved
   *   { type: "delta",         text }           - incremental token
   *   { type: "tool_start",    name, id }       - tool call starting
   *   { type: "tool_end",      name, id, ms,
   *                             isError }       - tool call finished
   *   { type: "final",         text, history,
   *                             toolsUsed }     - full response ready
   *   { type: "error",         error }          - aborted, return nothing
   *
   * The orchestrator falls back to the non-streaming code path if the
   * active provider does not implement `stream()`.
   */
  async *stream(
    request: ChatRequest,
  ): AsyncGenerator<OrchestratorStreamEvent, void, unknown> {
    const { message, userId, signal, fileIds } = this.validate(request);
    const history = request.history ?? [];

    // If the provider doesn't support streaming, degrade to non-stream
    // and emit a single final event. Callers still get a valid stream.
    if (!this.llm.stream) {
      try {
        const r = await this.chat({ message, userId, history, fileIds, signal });
        yield { type: "final", text: r.text, history: r.history, toolsUsed: r.toolsUsed };
      } catch (err) {
        yield { type: "error", error: this.toAppError(err) };
      }
      return;
    }

    let context: ChatContextBundle;
    try {
      context = await this.fetchContext(userId, signal);
    } catch (err) {
      yield { type: "error", error: this.toAppError(err) };
      return;
    }

    const prepared = await this.prepareTurn(context, message, history, signal);
    const { tools, mcpDegraded } = prepared;
    const messages = prepared.messages;
    const toolsUsed: ToolExecutionMeta[] = [];
    const allowed = new Set(context.tools);
    const renderByTool = buildRenderIndex(tools);
    // See chat() for rationale — capture renderable blocks across tool
    // rounds to append to the final text.
    const capturedBlocks: CardsBlock[] = [];
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      round++;

      let aggregated = "";
      let toolCalls: ToolCall[] | null = null;
      let assistantMessage: ChatMessage | null = null;
      let streamError: Error | null = null;

      try {
        for await (const ev of this.llm.stream({ messages, tools, signal })) {
          // Bail early if the caller disconnected.
          if (signal?.aborted) {
            streamError = new Error("client_aborted");
            break;
          }

          if (ev.type === "delta") {
            aggregated += ev.text;
            yield { type: "delta", text: ev.text };
          } else if (ev.type === "tool_calls") {
            toolCalls = ev.toolCalls;
            assistantMessage = ev.assistantMessage;
          } else if (ev.type === "done") {
            // `done.text` is authoritative when present.
            if (ev.text) aggregated = ev.text;
          } else if (ev.type === "error") {
            streamError = ev.error;
            break;
          }
        }
      } catch (err) {
        streamError = err as Error;
      }

      if (streamError) {
        if (isAbortError(streamError)) {
          yield { type: "error", error: new AppError(499, "client_aborted", "APP_ERROR") };
        } else {
          yield { type: "error", error: this.mapLlmError(streamError) };
        }
        return;
      }

      // No tool calls → the turn is done.
      if (!toolCalls || toolCalls.length === 0 || !assistantMessage) {
        const finalText = appendCardsBlocks(aggregated, capturedBlocks);
        // Emit the cards-block suffix as a trailing delta so the
        // client's progressive rendering accumulator matches the final
        // text exactly — otherwise the gallery would only appear for a
        // moment on the `final` event and then vanish on the next
        // re-render that replays the deltas.
        const suffix = finalText.slice(aggregated.length);
        if (suffix.length > 0) yield { type: "delta", text: suffix };
        messages.push({ role: "assistant", content: finalText });
        yield { type: "final", text: finalText, history: messages, toolsUsed };
        return;
      }

      // We have tool calls. Record the assistant message and execute
      // them sequentially, emitting per-tool lifecycle events so the UI
      // can show a "running …" chip.
      messages.push(assistantMessage);

      for (const toolCall of toolCalls) {
        yield { type: "tool_start", name: toolCall.name, id: toolCall.id };
        const { meta, cards } = await this.executeToolCall({
          toolCall,
          userId,
          allowed,
          renderByTool,
          messages,
          mcpDegraded,
          fileIds,
          signal,
        });
        toolsUsed.push(meta);
        if (cards) capturedBlocks.push(cards);
        yield {
          type: "tool_end",
          name: meta.name,
          id: toolCall.id,
          durationMs: meta.durationMs,
          isError: meta.isError,
        };
      }
    }

    yield { type: "error", error: new MaxRoundsExceededError(MAX_TOOL_ROUNDS) };
  }

  /* ================================================================== */
  /*  Internals                                                          */
  /* ================================================================== */

  private validate(request: ChatRequest): {
    message: string;
    userId: string;
    fileIds?: string[];
    signal?: AbortSignal;
  } {
    const { message, userId, fileIds, signal } = request;
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
      // Distinct code from INVALID_INPUT so the frontend can redirect
      // to the login flow rather than show a generic error.
      throw new AppError(
        400,
        '"userId" is required — ensure the frontend forwards the logged-in user id.',
        "USER_ID_REQUIRED",
      );
    }
    if (!message || typeof message !== "string" || message.trim() === "") {
      throw new ValidationError('"message" is required and must be non-empty.');
    }
    return { message: message.trim(), userId: userId.trim(), fileIds, signal };
  }

  /**
   * Fetches the chat-context bundle and maps failures to the typed
   * error hierarchy:
   *   - 404 from sdp-service → UserNotFoundError
   *   - abort                → UpstreamTimeoutError
   *   - anything else        → ChatContextUnavailableError
   */
  private async fetchContext(
    userId: string,
    signal?: AbortSignal,
  ): Promise<ChatContextBundle> {
    try {
      return await this.contextFetcher.fetch(userId, signal);
    } catch (err) {
      if (err instanceof ChatContextFetchError) {
        if (err.statusCode === 404) {
          throw new UserNotFoundError(userId);
        }
        if (isAbortError(err)) {
          throw new UpstreamTimeoutError("sdp-service");
        }
        throw new ChatContextUnavailableError(err.message);
      }
      if (isAbortError(err)) {
        throw new UpstreamTimeoutError("sdp-service");
      }
      throw new ChatContextUnavailableError((err as Error)?.message);
    }
  }

  /**
   * Resolves tools from MCP, intersects with the allowlist, composes
   * the initial message list. When MCP returns an empty tool list
   * (degraded), the system prompt gets an advisory appended so the LLM
   * doesn't invent tool names.
   */
  private async prepareTurn(
    context: ChatContextBundle,
    message: string,
    history: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<{
    messages: ChatMessage[];
    tools: ToolDefinition[];
    mcpDegraded: boolean;
  }> {
    // Tool discovery. McpClientService returns [] when it's in
    // graceful-degrade mode and the server is unreachable; we treat
    // an empty list as "text-only mode" for this turn.
    let allTools: ToolDefinition[] = [];
    try {
      allTools = await this.mcp.listTools(signal);
    } catch (err) {
      // Unexpected: graceful-degrade should have eaten this. Log and
      // carry on text-only rather than failing the request.
      logger.warn(
        { err: (err as Error)?.message },
        "mcp_list_tools_unexpected_error",
      );
      allTools = [];
    }

    const allowed = new Set(context.tools);
    const tools = allTools.filter((t) => allowed.has(t.name));
    // We only advise the LLM about a degraded backend when MCP itself
    // signals it (via the `degraded` flag set inside listTools()'s
    // graceful-degrade branch). An empty tool list that simply
    // reflects this user's allowlist is legitimate and must not
    // produce a "tools unavailable" notice.
    const mcpDegraded = Boolean(
      (this.mcp as unknown as { degraded?: boolean }).degraded,
    );

    const messages: ChatMessage[] = [...history];
    if (messages.length === 0) {
      const systemPrompt = mcpDegraded
        ? context.systemPrompt + MCP_DEGRADED_NOTICE
        : context.systemPrompt;
      messages.push({ role: "system", content: systemPrompt });
    } else if (mcpDegraded) {
      // Mid-conversation degradation: inject a fresh system notice so
      // the LLM stops planning around tools it no longer has.
      messages.push({ role: "system", content: MCP_DEGRADED_NOTICE.trim() });
    }
    messages.push({ role: "user", content: message });

    return { messages, tools, mcpDegraded };
  }

  private assistantToolCallMessage(response: LlmResponse): ChatMessage {
    if (response.meta?.assistantMessage) {
      return response.meta.assistantMessage as ChatMessage;
    }
    return {
      role: "assistant",
      content: (response.toolCalls ?? [])
        .map((tc) => `[Calling ${tc.name}]`)
        .join(", "),
    };
  }

  /**
   * Handles one tool call end-to-end: allowlist → rate-limit →
   * execution → response message. Always appends a `tool` message to
   * `messages`. Returns execution metadata plus — when the tool's spec
   * carried a render hint — a renderable block for the UI.
   *
   * There is NO per-tool branching here: `renderByTool` is built from
   * tool descriptors the MCP server advertised, so a new renderable
   * tool is a backend-only change.
   *
   * File ID auto-injection: When the user has uploaded files (fileIds),
   * this method automatically injects them into tool arguments if the
   * tool expects document-related parameters and they weren't provided
   * by the LLM. Common patterns: documentId, fileId, documentIds, attachmentIds.
   */
  private async executeToolCall(args: {
    toolCall: ToolCall;
    userId: string;
    allowed: Set<string>;
    renderByTool: Map<string, ToolRenderHint>;
    messages: ChatMessage[];
    mcpDegraded: boolean;
    fileIds?: string[];
    signal?: AbortSignal;
  }): Promise<{ meta: ToolExecutionMeta; cards?: CardsBlock }> {
    const { toolCall, userId, allowed, renderByTool, messages, mcpDegraded, fileIds, signal } = args;
    const start = Date.now();

    // MCP is degraded — short-circuit every tool call. The assistant
    // has already been told it's text-only; this is belt-and-braces.
    if (mcpDegraded) {
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({
          error: "mcp_unavailable",
          message:
            "Backend tools are temporarily unavailable. Continue text-only and advise the user to retry in a moment.",
        }),
      });
      return {
        meta: {
          name: toolCall.name,
          durationMs: Date.now() - start,
          isError: true,
        },
      };
    }

    // Guard 1: allowlist enforcement.
    if (!allowed.has(toolCall.name)) {
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({
          error: `Tool "${toolCall.name}" is not permitted for this user.`,
        }),
      });
      return {
        meta: {
          name: toolCall.name,
          durationMs: Date.now() - start,
          isError: true,
        },
      };
    }

    // Guard 2: per-user, per-tool rate limit.
    const decision = await this.rateLimiter.check(userId, toolCall.name);
    if (!decision.allowed) {
      rateLimitBlockedTotal.labels(toolCall.name).inc();
      const retrySec = Math.ceil((decision.retryAfterMs ?? 0) / 1000);
      const windowSec = Math.round(decision.windowMs / 1000);
      logger.warn(
        {
          userId,
          tool: toolCall.name,
          current: decision.current,
          limit: decision.limit,
          windowSec,
          retrySec,
        },
        "rate_limit_blocked",
      );
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify({
          error: "rate_limited",
          tool: toolCall.name,
          limit: decision.limit,
          windowSeconds: windowSec,
          retryAfterSeconds: retrySec,
          message:
            `This action was already performed recently for this user. ` +
            `Tell the user it's been submitted and they can retry in ${retrySec}s ` +
            `if they explicitly need another submission. Do not silently retry.`,
        }),
      });
      return {
        meta: {
          name: toolCall.name,
          durationMs: Date.now() - start,
          isError: true,
        },
      };
    }

    // Execute. `executeTool` never throws — it returns an error
    // ToolResult. That's intentional: tool failures should be
    // recoverable turns, not whole-chat aborts.
    let result: ToolResult;
    try {
      // Parse arguments and auto-inject file IDs if applicable
      const parsedArgs = this.parseArguments(toolCall.arguments);
      const enrichedArgs = this.enrichArgsWithFileIds(parsedArgs, fileIds);
      
      result = await this.mcp.executeTool(
        toolCall.name,
        enrichedArgs,
        signal,
      );
    } catch (err) {
      // Defensive: in case the contract changes, still surface as a
      // tool error rather than a 500.
      result = {
        content: JSON.stringify({
          error: `Tool execution failed: ${(err as Error)?.message ?? "unknown"}`,
        }),
        isError: true,
      };
    }

    const content = result.structured
      ? resultToToon(result.structured)
      : result.content;

    messages.push({
      role: "tool",
      toolCallId: toolCall.id,
      content,
    });

    // Generic render dispatch: if this tool's spec declared a render
    // hint and the call succeeded, project the payload into a CardsBlock
    // and surface it to the caller. Orchestrator stays entirely
    // tool-name-agnostic.
    //
    // A single structured log per tool call captures the full render
    // decision — whether a hint was present, whether extraction
    // produced a block, and why nothing was emitted when that's the
    // case. The four terminal "decision" values let ops filter logs by
    // cause without regex-ing message strings:
    //   - "tool_error"     : tool itself failed; no projection attempted.
    //   - "no_hint"        : tool has no render metadata; nothing to do.
    //   - "projection_miss": hint present, but the payload shape didn't
    //                        yield a block (usually a schema drift bug).
    //   - "emitted"        : a CardsBlock was produced and returned.
    let cards: CardsBlock | undefined;
    let renderDecision: "tool_error" | "no_hint" | "projection_miss" | "emitted";
    const hint = renderByTool.get(toolCall.name);

    if (result.isError) {
      renderDecision = "tool_error";
    } else if (!hint) {
      renderDecision = "no_hint";
    } else {
      cards = extractCardsBlock(result, hint);
      renderDecision = cards ? "emitted" : "projection_miss";
    }

    logger.info(
      {
        tool: toolCall.name,
        hint: hint ?? null,
        decision: renderDecision,
        produced: cards?.items.length ?? 0,
        knownRenderableTools: Array.from(renderByTool.keys()),
      },
      "cards_render_decision",
    );

    return {
      meta: {
        name: toolCall.name,
        durationMs: Date.now() - start,
        isError: result.isError,
      },
      cards,
    };
  }

  private parseArguments(
    args: Record<string, unknown> | string | undefined,
  ): Record<string, unknown> {
    if (!args) return {};
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch {
        return {};
      }
    }
    return args;
  }

  /**
   * Auto-injects file IDs into tool arguments when the user has uploaded
   * files and the tool expects document-related parameters.
   * 
   * Injection patterns:
   * - Single file param (documentId, fileId, attachmentId) → first fileId
   * - Array param (documentIds, fileIds, attachmentIds) → all fileIds
   * 
   * Only injects if the parameter is missing from the LLM's arguments.
   * This preserves LLM control while providing sensible defaults.
   */
  private enrichArgsWithFileIds(
    args: Record<string, unknown>,
    fileIds?: string[],
  ): Record<string, unknown> {
    if (!fileIds || fileIds.length === 0) return args;

    const enriched = { ...args };

    // Single document ID patterns (inject first file ID)
    const singleIdKeys = ["documentId", "fileId", "attachmentId", "medicalDocumentId"];
    for (const key of singleIdKeys) {
      if (enriched[key] === undefined) {
        enriched[key] = fileIds[0];
        logger.info(
          { key, fileId: fileIds[0] },
          "auto_inject_single_file_id",
        );
        break; // Only inject into one single-ID field
      }
    }

    // Multiple document IDs patterns (inject all file IDs)
    const multipleIdKeys = ["documentIds", "fileIds", "attachmentIds", "medicalDocumentIds"];
    for (const key of multipleIdKeys) {
      if (enriched[key] === undefined) {
        enriched[key] = fileIds;
        logger.info(
          { key, count: fileIds.length },
          "auto_inject_multiple_file_ids",
        );
        break; // Only inject into one multi-ID field
      }
    }

    return enriched;
  }

  private mapLlmError(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (isAbortError(err)) return new UpstreamTimeoutError("llm");
    const msg = (err as Error)?.message ?? "unknown LLM error";
    logger.error({ err: msg }, "llm_call_failed");
    return new LlmUnavailableError(msg);
  }

  private toAppError(err: unknown): AppError {
    if (err instanceof AppError) return err;
    return new AppError(
      500,
      (err as Error)?.message ?? "unknown error",
      "INTERNAL_ERROR",
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Stream event envelope                                              */
/* ------------------------------------------------------------------ */

export type OrchestratorStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; name: string; id: string }
  | {
      type: "tool_end";
      name: string;
      id: string;
      durationMs: number;
      isError: boolean;
    }
  | {
      type: "final";
      text: string;
      history: ChatMessage[];
      toolsUsed: ToolExecutionMeta[];
    }
  | { type: "error"; error: AppError };

/* ------------------------------------------------------------------ */
/*  Spec-driven UI-rendering helpers                                   */
/* ------------------------------------------------------------------ */

/**
 * Builds a name → render-hint lookup from the tool list the MCP
 * server advertised. Tools without a render hint are simply absent,
 * so callers can do `renderByTool.get(name)` and treat an undefined
 * result as "render as plain text".
 */
function buildRenderIndex(tools: ToolDefinition[]): Map<string, ToolRenderHint> {
  const out = new Map<string, ToolRenderHint>();
  for (const t of tools) {
    if (t.render) out.set(t.name, t.render);
  }
  return out;
}

/**
 * Projects a successful tool result into a renderable CardsBlock
 * according to the tool's render hint. Shape-tolerant so the gateway
 * doesn't care whether the backend returns a bare array, a wrapped
 * `{result: [...]}` / `{data: [...]}` / `{items: [...]}`, or a plain
 * JSON string.
 *
 * Returns undefined when the payload can't be projected — the
 * orchestrator simply skips emitting a block, and the user gets the
 * plain-text reply without a gallery.
 */
function extractCardsBlock(
  result: ToolResult,
  hint: ToolRenderHint,
): CardsBlock | undefined {
  const raw: unknown = result.structured ?? safeJsonParse(result.content);
  const list = unwrapArray(raw);
  if (!list) return undefined;

  // Spec-supplied field names take priority; fall back to the generic
  // `code` / `name` which is what most JSON APIs return unadorned.
  const codeKeys = uniq([hint.itemCode, "code", "id"]);
  const nameKeys = uniq([hint.itemName, "name", "title", "label"]);

  const items: Array<{ code: string; name: string }> = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const code = pickString(e, codeKeys);
    const name = pickString(e, nameKeys);
    if (!code || !name) continue;
    items.push({ code, name });
  }
  return items.length > 0 ? { kind: hint.kind, items } : undefined;
}

/**
 * Appends one or more CardsBlock payloads as ```cards fenced JSON
 * inside the final assistant text. Each block becomes its own fence
 * so a turn that returned several galleries stays readable.
 */
function appendCardsBlocks(text: string, blocks: CardsBlock[]): string {
  if (!blocks || blocks.length === 0) return text;
  let out = text;
  for (const block of blocks) {
    const json = JSON.stringify(block);
    const sep = out.endsWith("\n") ? "\n" : "\n\n";
    out = `${out}${sep}\`\`\`${CARDS_FENCE}\n${json}\n\`\`\``;
  }
  return out;
}

function uniq(xs: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function safeJsonParse(raw: string | undefined): unknown {
  if (!raw || typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Unwraps a list payload. Handles both bare arrays and arrays buried
 * under the conventional envelope keys the mcp-server's
 * `toStructuredRecord` helper uses ("result"), plus common Spring/LLM
 * conventions ("data", "items"). Legacy `"devices"` is still accepted
 * for backwards compatibility with older backends that haven't moved
 * to the generic envelope.
 */
function unwrapArray(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["result", "data", "items", "devices"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return undefined;
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/* Re-export for tests that want to introspect the constant. */
export { MAX_TOOL_ROUNDS };
/** Internal exports solely for unit tests; not part of the public API. */
export {
  extractCardsBlock as _extractCardsBlock,
  appendCardsBlocks as _appendCardsBlocks,
  buildRenderIndex as _buildRenderIndex,
};
/* Shut lint up about unused imports when the types are only referenced in JSDoc. */
export type { ToolDefinition };
// Re-export the stream-event types that the LLM layer defines so callers don't
// have to reach across two modules.
export type { LlmStreamEvent };
