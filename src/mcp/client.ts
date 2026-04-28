// ai-gateway/src/mcp/client.ts
//
// MCP client service — connects to the MCP server, discovers tools,
// converts them to provider-agnostic ToolDefinitions, and executes
// tool calls.
//
// Hardened for production use:
//   * Per-call timeouts (configurable; defaults from config.mcp.timeoutMs).
//   * AbortSignal propagation so a disconnected client instantly
//     releases an in-flight tool invocation.
//   * Tool discovery is cached with a short TTL rather than forever —
//     so a redeployed MCP server eventually surfaces its new tools
//     without a gateway restart.
//   * When the MCP server is unreachable AND `degradeGracefully` is on,
//     `listTools()` returns an empty array so the orchestrator can
//     still reply with text only.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";
import type { ToolDefinition, ToolParameter, ToolRenderHint } from "../llm/types.js";
import { linkSignals, timeoutSignal, isAbortError } from "../resilience/timeout.js";

/**
 * Operator-supplied render hints, keyed by tool name. Applied only when
 * the MCP server did not advertise an upstream `_meta.render` for a tool
 * — upstream hints always win. This exists so the gallery feature works
 * against older mcp-server / sdp-service builds that haven't been
 * rebuilt with the `x-mcp-tool.render` OpenAPI annotation yet.
 */
export type ToolRenderOverrides = Record<string, ToolRenderHint>;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ToolResult {
  content: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

export interface McpClientOptions {
  serverUrl?: string;
  timeoutMs?: number;
  toolDiscoveryTtlMs?: number;
  degradeGracefully?: boolean;
  /**
   * Name → render-hint fallback. See {@link ToolRenderOverrides}. Only
   * applied when the MCP tool descriptor lacks an upstream `_meta.render`.
   */
  toolRenderOverrides?: ToolRenderOverrides;
}

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class McpClientService {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private cachedTools: ToolDefinition[] | null = null;
  private cachedAt = 0;
  /**
   * Set to true when the most recent listTools() call failed and we
   * served an empty list via graceful degradation. Callers (notably
   * the orchestrator) use this to distinguish "MCP works, this user
   * just has nothing allowlisted" from "MCP is down" — the latter
   * needs a system-prompt advisory, the former does not.
   */
  private _degraded = false;
  private readonly serverUrl: string;
  private readonly timeoutMs: number;
  private readonly toolDiscoveryTtlMs: number;
  private readonly degradeGracefully: boolean;
  private readonly toolRenderOverrides: ToolRenderOverrides;

  /** Observable state for the orchestrator. */
  get degraded(): boolean {
    return this._degraded;
  }

  constructor(opts: McpClientOptions = {}) {
    this.serverUrl = opts.serverUrl ?? config.mcp.serverUrl;
    this.timeoutMs = opts.timeoutMs ?? config.mcp.timeoutMs;
    this.toolDiscoveryTtlMs =
      opts.toolDiscoveryTtlMs ?? Math.max(5 * 60 * 1000, config.mcp.timeoutMs);
    this.degradeGracefully =
      opts.degradeGracefully ?? config.mcp.degradeGracefully;
    this.toolRenderOverrides =
      opts.toolRenderOverrides ?? config.mcp.toolRenderOverrides ?? {};
  }

  /**
   * Lazily connects (or returns the in-flight connection promise so
   * concurrent callers don't double-connect).
   */
  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new Client({ name: "ai-gateway", version: "2.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.serverUrl));
      await client.connect(transport);
      this.client = client;
      logger.info({ url: this.serverUrl }, "mcp_client_connected");
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Discovers available tools. When `degradeGracefully` is on and the
   * MCP server is unreachable, returns `[]` and logs — the orchestrator
   * then answers with text only.
   */
  async listTools(signal?: AbortSignal): Promise<ToolDefinition[]> {
    if (this.cachedTools && Date.now() - this.cachedAt < this.toolDiscoveryTtlMs) {
      return this.cachedTools;
    }

    try {
      const client = await this.connect();
      const linked = linkSignals(signal, timeoutSignal(this.timeoutMs));
      const { tools } = await client.listTools(undefined, { signal: linked });

      this.cachedTools = tools.map((tool): ToolDefinition => {
        const inputSchema = (tool.inputSchema ?? {}) as Record<string, unknown>;
        // MCP tool descriptors carry non-protocol hints under `_meta`
        // (see MCP spec §Tools / ToolSchema._meta). We extract the
        // render hint here so the orchestrator can dispatch generically
        // on tool shape instead of tool name.
        const meta = (tool as { _meta?: Record<string, unknown> })._meta;
        const upstreamRender = extractRenderHint(meta?.render);
        // Upstream wins; fall back to operator-supplied override so the
        // gallery works even when the backend OpenAPI pipeline hasn't
        // been updated yet. Extract-then-validate the override too so a
        // malformed config entry silently no-ops (matches upstream rule).
        const overrideRender = upstreamRender
          ? undefined
          : extractRenderHint(this.toolRenderOverrides[tool.name]);
        const render = upstreamRender ?? overrideRender;
        return {
          name: tool.name,
          description: tool.description ?? "",
          parameters: {
            type: "object",
            properties: (inputSchema.properties ?? {}) as Record<string, ToolParameter>,
            required: (inputSchema.required ?? []) as string[],
          },
          ...(render ? { render } : {}),
        };
      });
      this.cachedAt = Date.now();
      this._degraded = false;
      // Surface which tools carried a render hint — invaluable when the
      // frontend gallery doesn't appear and we need to diagnose whether
      // the upstream OpenAPI → MCP pipeline is delivering `_meta.render`.
      // We also annotate the *source* (upstream vs operator override) so
      // operators can tell whether the backend pipeline is healthy or
      // they're silently relying on the fallback.
      const overrideNames = new Set(
        Object.keys(this.toolRenderOverrides ?? {}),
      );
      const withRender = this.cachedTools
        .filter((t) => t.render)
        .map((t) => {
          const rawMeta = (tools.find((x) => x.name === t.name) as {
            _meta?: Record<string, unknown>;
          })._meta;
          const source = extractRenderHint(rawMeta?.render)
            ? "upstream"
            : overrideNames.has(t.name)
              ? "override"
              : "unknown";
          return { name: t.name, render: t.render, source };
        });
      logger.info(
        {
          count: this.cachedTools.length,
          tools: this.cachedTools.map((t) => t.name),
          withRender,
          overrides: Array.from(overrideNames),
        },
        "mcp_tools_discovered",
      );
      return this.cachedTools;
    } catch (err) {
      if (this.degradeGracefully) {
        logger.warn(
          { err: (err as Error)?.message, url: this.serverUrl },
          "mcp_list_tools_failed_degrading",
        );
        this._degraded = true;
        return [];
      }
      throw err;
    }
  }

  invalidateCache(): void {
    this.cachedTools = null;
    this.cachedAt = 0;
  }

  /**
   * Executes a tool with a hard deadline and abort propagation.
   * Any failure is converted into a ToolResult with isError=true — the
   * orchestrator surfaces this to the LLM as a recoverable tool error
   * rather than aborting the entire chat turn.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const linked = linkSignals(signal, timeoutSignal(this.timeoutMs));
    let client: Client;
    try {
      client = await this.connect();
    } catch (err) {
      return this.buildErrorResult(
        `MCP unreachable: ${(err as Error)?.message ?? "unknown"}`,
      );
    }

    try {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { signal: linked },
      );

      const structured = (result as any)?.structuredContent as
        | Record<string, unknown>
        | undefined;

      const textParts: string[] = [];
      if (Array.isArray(result.content)) {
        for (const part of result.content) {
          if (part.type === "text" && typeof part.text === "string") {
            textParts.push(part.text);
          }
        }
      }

      const content = structured
        ? JSON.stringify(structured, null, 2)
        : textParts.length > 0
          ? textParts.join("\n")
          : JSON.stringify(result, null, 2);

      return {
        content,
        structured: structured ?? undefined,
        isError: result.isError === true,
      };
    } catch (err) {
      if (isAbortError(err)) {
        return this.buildErrorResult(
          `Tool "${name}" exceeded ${this.timeoutMs}ms timeout`,
        );
      }
      return this.buildErrorResult(
        `Tool "${name}" failed: ${(err as Error)?.message ?? "unknown error"}`,
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        logger.warn({ err: (err as Error)?.message }, "mcp_disconnect_error");
      }
      this.client = null;
      this.cachedTools = null;
      this.cachedAt = 0;
      logger.info("mcp_client_disconnected");
    }
  }

  private buildErrorResult(msg: string): ToolResult {
    return {
      content: JSON.stringify({ error: msg }),
      isError: true,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalises an `_meta.render` value from the MCP server into a
 * strict ToolRenderHint. Unknown / malformed shapes return undefined
 * so we never propagate junk into the orchestrator — the gallery
 * feature silently no-ops instead of throwing.
 *
 * Exported for unit tests; no public consumers outside this module.
 */
export function extractRenderHint(raw: unknown): ToolRenderHint | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== "string" || o.kind.length === 0) return undefined;
  const out: ToolRenderHint = { kind: o.kind };
  if (typeof o.itemCode === "string") out.itemCode = o.itemCode;
  if (typeof o.itemName === "string") out.itemName = o.itemName;
  return out;
}
