// ADR-0009: evidence classification.
// We do NOT classify tool output content — that's the LLM's job.
// We only classify "did the output look like the same thing as last time?"
// to feed the neutralStreak counter.
//
// NEUTRAL is the default for read/grep/board-read and similar inspection tools
// unless a fresh result is detected. CONFIRM/REFUTE/CONSTRAIN/ENABLE are
// declared by the LLM in its next turn (via tool input side-effects) — the
// hook does not assert them.

import { createHash } from "node:crypto";

export type EvidenceDelta = "CONFIRM" | "REFUTE" | "CONSTRAIN" | "ENABLE" | "NEUTRAL";

export interface EvidenceInput {
  tool: string;
  output: string;
  previousOutputs: string[];
}

// Content-shape hash. Two outputs hash equal iff they share structure
// (same first 4KB after whitespace collapse) — tolerates timestamps/PIDs,
// catches "the exact same line again".
function shapeHash(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim().slice(0, 4096);
  return createHash("sha256").update(collapsed).digest("hex").slice(0, 16);
}

// Tools whose output is "content I need to read" — these are NEUTRAL by default
// and the LLM is responsible for declaring what they confirmed/refuted.
const INSPECTION_TOOLS = new Set(["read", "grep", "search", "board"]);

export function classify({ tool, output, previousOutputs }: EvidenceInput): EvidenceDelta {
  const t = (tool || "").toLowerCase();
  if (!INSPECTION_TOOLS.has(t)) {
    // Side-effecting tools (edit, write, bash) — by definition, they did something.
    // Default to ENABLE; the LLM can downgrade via its own self-report.
    return "ENABLE";
  }
  if (previousOutputs.length === 0) return "NEUTRAL";
  const h = shapeHash(output);
  const allSame = previousOutputs.slice(-2).every(p => shapeHash(p) === h);
  if (allSame) return "NEUTRAL"; // No new content
  // Content shape changed but tool is inspection-only → still NEUTRAL from the hook's view.
  // The LLM will declare CONFIRM/REFUTE based on what it read.
  return "NEUTRAL";
}
