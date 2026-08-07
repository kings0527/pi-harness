// ADR-0009: evidence classification tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../core/anti-drift/evidence.ts";

test("inspection tool with no prior output → NEUTRAL", () => {
  assert.equal(
    classify({ tool: "read", output: "hello", previousOutputs: [] }),
    "NEUTRAL",
  );
});

test("inspection tool with same-shape output as last 2 → NEUTRAL", () => {
  const out = "line 1\nline 2\nline 3\n";
  assert.equal(
    classify({ tool: "read", output: out, previousOutputs: [out, out] }),
    "NEUTRAL",
  );
});

test("inspection tool with whitespace-only differences → NEUTRAL (shape hash tolerant)", () => {
  const a = "line 1\nline 2";
  const b = "  line 1\n  line 2  ";
  assert.equal(
    classify({ tool: "read", output: b, previousOutputs: [a, a] }),
    "NEUTRAL",
  );
});

test("inspection tool with structurally different content → NEUTRAL (hook stays agnostic)", () => {
  // The hook does not assert CONFIRM/REFUTE/CONSTRAIN/ENABLE — those are LLM-declared.
  // The hook's only output is NEUTRAL (consume the streak counter) or non-NEUTRAL.
  assert.equal(
    classify({ tool: "read", output: "completely different content", previousOutputs: ["foo bar"] }),
    "NEUTRAL",
  );
});

test("side-effect tool (edit) → ENABLE", () => {
  assert.equal(
    classify({ tool: "edit", output: "ok", previousOutputs: [] }),
    "ENABLE",
  );
});

test("side-effect tool (write) → ENABLE", () => {
  assert.equal(
    classify({ tool: "write", output: "ok", previousOutputs: [] }),
    "ENABLE",
  );
});

test("side-effect tool (bash) → ENABLE", () => {
  assert.equal(
    classify({ tool: "bash", output: "ok", previousOutputs: [] }),
    "ENABLE",
  );
});

test("board (inspection) with no prior → NEUTRAL", () => {
  assert.equal(
    classify({ tool: "board", output: "note text", previousOutputs: [] }),
    "NEUTRAL",
  );
});
