// ai-gateway/src/orchestrator/toon.ts
// TOON (Token Oriented Object Notation) serializer.
//
// Converts structured data into a compact format optimised for LLM token usage.
// TOON uses:
//   - YAML-style indentation (no braces/brackets) for objects
//   - CSV-style tabular format for uniform arrays
//   - Minimal punctuation
//
// This achieves 30-60% token savings compared to JSON.

import type { ToolDefinition, ToolParameter } from "../llm/types.js";

/* ------------------------------------------------------------------ */
/*  TOON serializer for tool definitions                               */
/* ------------------------------------------------------------------ */

/**
 * Converts an array of ToolDefinitions into TOON format.
 * This is what gets sent to the LLM as the tool description context.
 */
export function toolsToToon(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "# No tools available";

  const sections: string[] = [];

  for (const tool of tools) {
    sections.push(toolToToon(tool));
  }

  return sections.join("\n---\n");
}

/**
 * Converts a single ToolDefinition to TOON format.
 */
function toolToToon(tool: ToolDefinition): string {
  const lines: string[] = [];

  lines.push(`tool: ${tool.name}`);
  lines.push(`desc: ${tool.description}`);

  const params = tool.parameters?.properties ?? {};
  const required = new Set(tool.parameters?.required ?? []);

  if (Object.keys(params).length > 0) {
    lines.push("params:");
    for (const [name, schema] of Object.entries(params)) {
      const req = required.has(name) ? "*" : "?";
      const type = schema.type ?? "string";
      const desc = schema.description ? ` # ${schema.description}` : "";
      const enumVals = schema.enum ? ` [${schema.enum.join(",")}]` : "";
      lines.push(`  ${name}: ${type}${req}${enumVals}${desc}`);
    }
  } else {
    lines.push("params: none");
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  TOON serializer for tool results                                   */
/* ------------------------------------------------------------------ */

/**
 * Converts a tool result (typically JSON) to compact TOON format.
 * Used to reduce token consumption for tool outputs sent back to the LLM.
 */
export function resultToToon(data: unknown): string {
  if (data === null || data === undefined) return "null";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);

  if (Array.isArray(data)) {
    return arrayToToon(data);
  }

  if (typeof data === "object") {
    return objectToToon(data as Record<string, unknown>, 0);
  }

  return String(data);
}

function objectToToon(obj: Record<string, unknown>, indent: number): string {
  const prefix = "  ".repeat(indent);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${prefix}${key}: null`);
    } else if (typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      lines.push(objectToToon(value as Record<string, unknown>, indent + 1));
    } else if (Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      lines.push(indentLines(arrayToToon(value), indent + 1));
    } else {
      lines.push(`${prefix}${key}: ${value}`);
    }
  }

  return lines.join("\n");
}

/**
 * Converts arrays to CSV-style tabular format if items are uniform objects,
 * or simple list format otherwise.
 */
function arrayToToon(arr: unknown[]): string {
  if (arr.length === 0) return "[]";

  // Check if all items are uniform objects (same keys).
  if (arr.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    const objects = arr as Record<string, unknown>[];
    const keys = Object.keys(objects[0]);
    const isUniform = objects.every(
      (obj) =>
        Object.keys(obj).length === keys.length &&
        keys.every((k) => k in obj),
    );

    if (isUniform && keys.length > 0) {
      // CSV-style tabular format.
      const header = keys.join(" | ");
      const rows = objects.map((obj) =>
        keys.map((k) => formatValue(obj[k])).join(" | "),
      );
      return [header, ...rows].join("\n");
    }
  }

  // Fallback: simple list.
  return arr.map((item, i) => `- ${formatValue(item)}`).join("\n");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") {
    if (Array.isArray(value)) return `[${value.map(formatValue).join(",")}]`;
    // Inline small objects.
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length <= 3) {
      return entries.map(([k, v]) => `${k}:${formatValue(v)}`).join(" ");
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function indentLines(text: string, indent: number): string {
  const prefix = "  ".repeat(indent);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
