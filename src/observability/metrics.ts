// ai-gateway/src/observability/metrics.ts
//
// Prometheus metrics registry. Instruments the hot paths of the
// gateway so we can answer:
//   * Is the system healthy right now? (request rate, error rate, p95)
//   * Which upstream is slow? (per-target histograms)
//   * Are we shedding load? (rate-limit counters)
//   * How is the circuit breaker behaving? (state-change gauge)
//
// Design:
//   * `prom-client` default registry is used so `/metrics` just calls
//     `register.metrics()`. No custom registry plumbing.
//   * Default Node process metrics (cpu, memory, event loop lag, gc)
//     are collected every 10s. They're the first thing an SRE checks
//     and cost effectively nothing.
//   * Labels are kept low-cardinality — never label on user id or
//     trace id. Only `route`, `status_code_class`, `outcome`, `target`.
//   * Metrics are only collected when `config.metrics.enabled`; the
//     module still exports no-op stubs so call sites don't have to
//     branch.

import client from "prom-client";

import { config } from "../config/env.js";

/* ------------------------------------------------------------------ */
/*  Registry / default metrics                                         */
/* ------------------------------------------------------------------ */

export const registry = client.register;

if (config.metrics.enabled) {
  client.collectDefaultMetrics({
    register: registry,
    prefix: "ai_gateway_",
    gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
  });
}

/* ------------------------------------------------------------------ */
/*  HTTP                                                               */
/* ------------------------------------------------------------------ */

export const httpRequestDuration = new client.Histogram({
  name: "ai_gateway_http_request_duration_seconds",
  help: "HTTP request duration in seconds, labelled by route and status class.",
  labelNames: ["method", "route", "status_class"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: config.metrics.enabled ? [registry] : [],
});

export const httpRequestsTotal = new client.Counter({
  name: "ai_gateway_http_requests_total",
  help: "Total number of HTTP requests handled.",
  labelNames: ["method", "route", "status_class"] as const,
  registers: config.metrics.enabled ? [registry] : [],
});

/* ------------------------------------------------------------------ */
/*  Upstreams (LLM, MCP, SDP)                                          */
/* ------------------------------------------------------------------ */

export const upstreamDuration = new client.Histogram({
  name: "ai_gateway_upstream_request_duration_seconds",
  help: "Upstream request duration in seconds.",
  labelNames: ["target", "outcome"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: config.metrics.enabled ? [registry] : [],
});

export const upstreamFailuresTotal = new client.Counter({
  name: "ai_gateway_upstream_failures_total",
  help: "Count of upstream failures, by target and kind.",
  labelNames: ["target", "kind"] as const,
  registers: config.metrics.enabled ? [registry] : [],
});

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                      */
/* ------------------------------------------------------------------ */

export const rateLimitBlockedTotal = new client.Counter({
  name: "ai_gateway_rate_limit_blocked_total",
  help: "Total rate-limit denials, labelled by tool.",
  labelNames: ["tool"] as const,
  registers: config.metrics.enabled ? [registry] : [],
});

/* ------------------------------------------------------------------ */
/*  Circuit breaker                                                    */
/* ------------------------------------------------------------------ */

export const circuitBreakerState = new client.Gauge({
  name: "ai_gateway_circuit_breaker_state",
  help: "Circuit breaker state: 0=closed, 1=half-open, 2=open.",
  labelNames: ["target"] as const,
  registers: config.metrics.enabled ? [registry] : [],
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function statusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}
