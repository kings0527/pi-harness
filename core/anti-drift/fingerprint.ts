// ADR-0009: action fingerprint normalization.
// Goal: detect "same tool, same target, same intent" without NLP.
// Strategy: extract (tool, normalized-target, intent-key) and join with a separator.

import { resolve } from "node:path";

export interface FingerprintInput {
  tool: string;
  input: Record<string, unknown> | undefined;
}

const SEP = "|";

// Tool-specific intent keys. For tools we don't know, fall back to a generic key.
// Adding a tool here is cheap; covering every tool is unnecessary.
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
      // Strip line numbers, hex addresses, and trailing whitespace so
      // `objdump -d 0x1000` and `objdump -d 0x1004` don't accidentally collide.
      // We only collapse the most common volatile tokens; deep semantic
      // equivalence is the LLM's job.
      const collapsed = cmd
        .replace(/0x[0-9a-fA-F]+/g, "0xADDR")
        .replace(/\b\d{4,}\b/g, "N")
        .replace(/\s+/g, " ")
        .trim();
      // Take the first 80 chars — long enough to discriminate, short enough to be stable.
      return `cmd=${collapsed.slice(0, 80)}`;
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
      // Generic: take the first 3 string keys in stable order.
      const keys = Object.keys(i).sort().slice(0, 3);
      return keys.map(k => `${k}=${String(i[k]).slice(0, 40)}`).join(";");
    }
  }
}

function normalizePath(p: string): string {
  // Resolve to absolute so "./foo" and "foo" collide.
  // Use process.cwd() as base — equivalent to what the model sees.
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
