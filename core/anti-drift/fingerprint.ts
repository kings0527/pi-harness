// ADR-0009 (revised): anti-drift fingerprint.
// Pure data, runtime-agnostic. No pi imports.
// Purpose: detect "same tool, same target, same intent" without NLP, so the
// runtime can WARN a human (stderr + events.jsonl) when the model repeats an
// action. We do NOT inject this into the model context — the LLM is trusted
// to know what it is doing. Warnings are for the human operator, not the LLM.

import { createHash } from "node:crypto";
import { resolve } from "node:path";

export interface FingerprintInput {
  tool: string;
  input: Record<string, unknown> | undefined;
}

const SEP = "|";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function intentKey(tool: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  switch (tool) {
    case "read": {
      const p = (i.file_path ?? i.path) as string | undefined;
      const off = i.offset ?? i.line_start;
      const lim = i.limit ?? i.line_count;
      return p ? `path=${normalizePath(p)};range=${off ?? 0}-${lim ?? "end"}` : "no-target";
    }
    case "bash": {
      const cmd = (i.command ?? i.cmd ?? "") as string;
      // Collapse volatile tokens: addresses, large numeric IDs, whitespace.
      const collapsed = cmd
        .replace(/0x[0-9a-fA-F]+/g, "0xADDR")
        .replace(/\b\d{4,}\b/g, "N")
        .replace(/\s+/g, " ")
        .trim();
      return `cmd-sha256=${hash(collapsed)}`;
    }
    case "edit":
    case "write": {
      const p = (i.file_path ?? i.path) as string | undefined;
      return p ? `path=${normalizePath(p)}` : "no-target";
    }
    case "grep":
    case "search": {
      const q = (i.query ?? i.pattern ?? i.q ?? "") as string;
      const p = (i.path ?? i.directory ?? ".") as string;
      return `q=${q};path=${normalizePath(p)}`;
    }
    default: {
      return `input-sha256=${hash(JSON.stringify(stableValue(i)))}`;
    }
  }
}

function normalizePath(p: string): string {
  try {
    return resolve(process.cwd(), p);
  } catch {
    return p;
  }
}

export function fingerprint({ tool, input }: FingerprintInput): string {
  const t = (tool || "unknown").toLowerCase();
  return [t, intentKey(t, input)].join(SEP);
}
