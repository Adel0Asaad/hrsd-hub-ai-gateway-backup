# ai-gateway

The LLM-orchestration service for the HRSD SDP MCP platform. Speaks HTTP (and SSE) to the frontend, OpenAI's Chat Completions API to the model, MCP over streamable-http to the tool server, and REST to sdp-service for per-user context.

For the full architecture see [`../docs/ARCHITECTURE-ai-gateway.md`](../docs/ARCHITECTURE-ai-gateway.md) and [`../docs/ARCHITECTURE-e2e.md`](../docs/ARCHITECTURE-e2e.md).

## Quick start

```bash
npm install
cp gateway.config.example.json gateway.config.json   # edit to taste
npm run dev                                           # tsx watch
```

Defaults bind to `127.0.0.1:3001`. Hit `/healthz` to verify the service is up and all downstream dependencies report healthy.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Watch mode via `tsx watch src/server.ts` |
| `npm run build` | Compile to `dist/` (tsc) |
| `npm start` | Run compiled build |
| `npm test` | Full test suite via `node --test` |
| `npm run test:watch` | Test suite in watch mode |

The test runner uses Node's built-in `node:test` harness with `tsx` for TypeScript. No Jest, no Vitest — zero extra test framework in the dependency graph.

## HTTP surface

| Method | Path | Body / Purpose |
|---|---|---|
| `POST` | `/chat` | One-shot turn — JSON in, JSON out |
| `POST` | `/chat/stream` | Same contract, SSE delta+tool_lifecycle+final |
| `GET`  | `/healthz` | Liveness + downstream dependency probe |
| `GET`  | `/metrics` | Prometheus scrape endpoint (see [`../docs/RUNBOOK-observability.md`](../docs/RUNBOOK-observability.md)) |

`POST /chat` request body:

```json
{
  "message": "show me available assistive devices",
  "userId": "u-123",
  "conversationId": "optional-client-generated",
  "history": [ { "role": "user", "content": "..." } ]
}
```

Response:

```json
{
  "conversationId": "...",
  "text": "Here are the available assistive devices:\n\n```cards\n{\"kind\":\"gallery\",\"items\":[...]}\n```",
  "history": [ ... ],
  "toolsUsed": [ { "name": "list_assistive_devices", "durationMs": 142 } ]
}
```

Note that the `text` field can include a fenced ` ```cards ` block — see the [cards rendering pipeline](#spec-driven-cards-rendering) section below.

## Configuration

Configuration is loaded from `gateway.config.json` and validated with Zod at startup. Fail-fast: the process exits non-zero on any schema violation so a bad config never reaches production.

Key blocks:

- `server.port`, `server.maxResponseBytes`
- `llm.provider`, `llm.apiKey`, `llm.model`, `llm.temperature`
- `mcp.url`, `mcp.connectTimeoutMs`, `mcp.requestTimeoutMs`
- `mcp.toolRenderOverrides` — operator-side escape hatch for missing render hints (§ [Render hint overrides](#render-hint-overrides))
- `sdp.baseUrl`, `sdp.timeoutMs`
- `rateLimits.default`, `rateLimits.perTool`
- `redis` (optional) — enable to back the KV store with Redis instead of the in-memory default
- `logging.level`, `logging.redact`

See `gateway.config.example.json` for the full shape.

## Token-efficient tool feedback via TOON

When a tool result is fed back into the next LLM turn, the gateway does not send raw JSON. It runs the structured payload through a **TOON** (Token Oriented Object Notation) serializer that trades JSON's punctuation for YAML-like indentation and CSV-like tabular rows.

### Why TOON

Every tool call in a multi-turn conversation feeds its output back into the model's context window for the next turn. For a discovery tool that returns 40 rows of `{ code, name, category, …}`, a JSON serialization looks like:

```json
[
  {"code": "WHEELCHAIR", "name": "كرسي متحرك", "category": "mobility"},
  {"code": "WALKER",     "name": "مشاية",      "category": "mobility"},
  ...
]
```

The **keys repeat on every row**. The LLM pays for every `"code":` and `"name":` and `"category":` on every item, which blows up tokens linearly with list length for zero new information.

TOON encodes the same data as a single header row plus compact values:

```
[40]{code,name,category}
  WHEELCHAIR,كرسي متحرك,mobility
  WALKER,مشاية,mobility
  ...
```

Empirically this saves **30-60% of tokens on typical tool-feedback payloads** depending on shape uniformity. That compounds: fewer input tokens on turn N ⇒ more headroom for output on turn N ⇒ shorter responses ⇒ lower latency and lower cost.

### When TOON runs

The serializer lives at `src/orchestrator/toon.ts` and exposes two entry points:

- `toolsToToon(tools)` — serializes the tool catalog once per turn for the system/tool section
- `resultToToon(data)` — serializes a single tool result before it is appended to the conversation as a `{ role: "tool" }` message

The orchestrator calls `resultToToon` at `src/orchestrator/chat.orchestrator.ts` only when the MCP result has `structured` data attached — `result.structured ? resultToToon(result.structured) : result.content`. String-only results pass through untouched.

### Format at a glance

- Primitives → their literal string form (`42`, `true`, `"hello"`, `null`).
- Uniform arrays of objects → CSV-style with a single column header row.
- Non-uniform arrays → fall back to a YAML-style list form.
- Objects → `key: value` with 2-space indentation for nesting.

The fallback paths are important: if the serializer cannot produce a compact uniform form it degrades gracefully instead of silently dropping fields.

### Tests

`tests/toon.test.ts` covers the serializer end-to-end: primitives, empty arrays, uniform arrays (CSV form), non-uniform arrays (list fallback), nested objects, nested arrays, and null-in-object semantics. Run it directly:

```bash
npm test -- --test-name-pattern="resultToToon"
```

### When to change it

TOON is an internal format. The only consumer is the LLM through the OpenAI provider. If you want to change the encoding:

1. Update `src/orchestrator/toon.ts`.
2. Update the tests in `tests/toon.test.ts`.
3. Verify round-trip rendering by running the cards-render integration tests — they feed structured payloads through the orchestrator and assert the final assistant text, which indirectly validates that the LLM still understood the tool output.

Do **not** send TOON to the frontend or store it anywhere durable. It is purely a wire optimization between the orchestrator and the LLM.

## Spec-driven cards rendering

The gateway does not hardcode any tool name when deciding whether to emit a gallery. Tools advertise a render hint via MCP's `_meta.render` extension; the gateway projects successful tool results into a `CardsBlock` and appends a fenced ` ```cards ` block to the final assistant text. The frontend parses the fence and routes on `block.kind`.

Four possible outcomes per tool invocation, logged as `cards_render_decision.decision`:

| Decision | Meaning | What to do |
|---|---|---|
| `tool_error` | MCP call failed | See [`../docs/RUNBOOK-missing-gallery.md`](../docs/RUNBOOK-missing-gallery.md) §4 |
| `no_hint` | Tool has no render metadata | [`RUNBOOK-missing-gallery.md`](../docs/RUNBOOK-missing-gallery.md) §5 — either add the hint upstream or use a config override |
| `projection_miss` | Hint present but payload shape didn't match | [`RUNBOOK-missing-gallery.md`](../docs/RUNBOOK-missing-gallery.md) §6 — schema drift, highest-signal failure mode |
| `emitted` | Gallery block produced | Happy path |

The `projection_miss` enum value is exposed as a Prometheus metric label (`ai_gateway_tool_calls_total{status="projection_miss"}`) and the platform alerts on any non-zero rate.

### Render hint overrides

For zero-deploy recovery when an upstream service is slow to ship a render hint, add a `mcp.toolRenderOverrides` entry to `gateway.config.json`:

```json
{
  "mcp": {
    "toolRenderOverrides": {
      "list_assistive_devices": {
        "kind": "gallery",
        "itemCode": "deviceCode",
        "itemName": "deviceName"
      }
    }
  }
}
```

Restart the gateway. The `mcp_tools_discovered` log line will show `source: "override"` for that tool. **Upstream always wins**: once the upstream service delivers a real hint, the override silently becomes a no-op. Remove overrides during the next maintenance window to keep the config clean.

## Observability

All logs are structured JSON via pino. Every log line carries `traceId` (UUID) which is also returned as the `x-trace-id` response header and propagated downstream as `mcp-trace-id` / `x-trace-id`.

Stable log contracts (ops tooling may safely key on these):

- `chat_request_received` — one per `/chat` turn
- `mcp_tools_discovered` — one per gateway-to-MCP session; shows render hint provenance
- `cards_render_decision` — one per tool invocation; the single highest-signal line
- `tool_call_succeeded` / `tool_call_failed` — per MCP call with timing
- `circuit_breaker_state` — state transitions of LLM / MCP breakers
- `chat_completed` — end of a successful turn

Prometheus metrics at `GET /metrics`:

- `ai_gateway_llm_requests_total{status}`
- `ai_gateway_tool_calls_total{tool,status}` — `status` includes `projection_miss`
- `ai_gateway_request_duration_seconds{route}`
- `ai_gateway_circuit_breaker_state{client}`
- `ai_gateway_rate_limit_denied_total{scope}`

See [`../docs/RUNBOOK-observability.md`](../docs/RUNBOOK-observability.md) for the full SLO treatment, alert rules, and dashboard recommendations.

## Testing

Tests live in `tests/` next to the service. The layout mirrors `src/` for navigation but is flat at the top level:

| File | What it covers |
|---|---|
| `chat-orchestrator.test.ts` | Core orchestrator tool-loop logic |
| `chat-routes.test.ts` | HTTP route layer against a stubbed orchestrator |
| `cards-render.test.ts` | Projection + render-index + metadata-driven integration |
| `smoke-cards-e2e.test.ts` | Full-path smoke: real Express + real orchestrator + fakes for LLM/MCP/SDP, asserts ` ```cards ` fences appear in POST responses |
| `error-handler.test.ts` | Error envelope shape and mapping |
| `openai-provider-mapping.test.ts` | Request/response translation against OpenAI SDK seams |
| `rate-limiter.test.ts` | Token-bucket semantics across KV backends |
| `sdp-client.test.ts` | HTTP client against sdp-service with retries and redaction |
| `toon.test.ts` | TOON serializer: primitives, arrays (CSV + fallback), objects |

Test doubles live in `tests/helpers/fakes.ts`:

- `FakeLlmProvider` replays a scripted sequence of responses
- `FakeMcpClient` serves a tool catalog and custom result handler
- `FakeChatContextFetcher` returns canned sdp-service bundles

All tests use Node's built-in `node:test` — no external framework. Run a single file with:

```bash
node --import tsx --test tests/smoke-cards-e2e.test.ts
```

## Deploy

`Dockerfile` builds a multi-stage production image. The service is stateless (Redis is optional state); deploy as N replicas behind a load balancer and wire `/healthz` into the LB health check so a bad instance is drained automatically.

Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting new connections, drain in-flight requests (bounded by `server.shutdownTimeoutMs`), close MCP and Redis clients, then exit.

## Related documents

- [`../docs/ARCHITECTURE-ai-gateway.md`](../docs/ARCHITECTURE-ai-gateway.md) — per-service architecture
- [`../docs/ARCHITECTURE-e2e.md`](../docs/ARCHITECTURE-e2e.md) — end-to-end platform
- [`../docs/RUNBOOK-missing-gallery.md`](../docs/RUNBOOK-missing-gallery.md) — troubleshooting the gallery pipeline
- [`../docs/RUNBOOK-observability.md`](../docs/RUNBOOK-observability.md) — log contracts, metrics, SLOs
- [`../docs/ASSESSMENT-2026-04-19.md`](../docs/ASSESSMENT-2026-04-19.md) — daily assessment notes
