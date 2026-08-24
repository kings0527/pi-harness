import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { estimateContextTokens } from "../core/context-size/index.ts";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");
}

test("完整常驻 prompt + doctrine inline + tool descriptions 保持在保守预算内", () => {
  const parts = [
    read("prompts/meta-principles.md"),
    read("prompts/collaboration-doctrine.md"),
    read("prompts/anti-drift.md"),
  ];

  const doctrineSource = read("extensions/doctrine.ts");
  parts.push(...[...doctrineSource.matchAll(/sections\.push\("((?:[^"\\]|\\.)*)"\)/g)].map(match => match[1]));

  for (const path of ["extensions/board.ts", "extensions/spawn.ts"]) {
    const source = read(path);
    parts.push(...[...source.matchAll(/description:\s*"((?:[^"\\]|\\.)*)"/g)].map(match => match[1]));
  }

  const corpus = parts.join("\n");
  assert.ok(estimateContextTokens(corpus) <= 900, "keep headroom below the 1000-token invariant");
});

test("ADR-0011 through ADR-0021 遵守十行格式", () => {
  for (const path of [
    "docs/decisions/0011-fixed-knowledge-handoff-placement.md",
    "docs/decisions/0012-preserve-context-warn-on-size.md",
    "docs/decisions/0013-frozen-auditable-context-injection.md",
    "docs/decisions/0014-hierarchical-knowledge-scopes.md",
    "docs/decisions/0015-persistent-goal.md",
    "docs/decisions/0016-append-only-runtime-references.md",
    "docs/decisions/0017-always-on-knowledge-catalog.md",
    "docs/decisions/0018-board-checkpoint-delta-feed.md",
    "docs/decisions/0019-context-headroom-guard.md",
    "docs/decisions/0020-board-integrity-guard.md",
    "docs/decisions/0021-proactive-reasoning-epochs.md",
    "docs/decisions/0022-goal-auto-continuation.md",
    "docs/decisions/0023-session-cumulative-reasoning-epochs.md",
    "docs/decisions/0024-early-compaction-headroom.md",
    "docs/decisions/0025-reasoning-epoch-observation.md",
  ]) {
    assert.ok(read(path).trimEnd().split("\n").length <= 10, `${path} exceeds 10 lines`);
  }
});

test("项目 knowledge 可被 Git 跟踪，完整内容路径无固定截断", () => {
  const ignoreLines = read(".gitignore").split("\n").map(line => line.trim());
  assert.ok(!ignoreLines.includes("knowledge/"));
  assert.doesNotMatch(read("extensions/context-feed.ts"), /maxBytes|totalBudget|3000 -/);
  assert.doesNotMatch(read("core/spawn/index.ts"), /OUTPUT_TAIL|output\.slice/);
  assert.doesNotMatch(read("core/board/digest.ts"), /notes omitted|maxBytes/);
});

test("runtime references are append-only across user turns and goal completion is post-execution", () => {
  const source = read("extensions/goal.ts");
  const contextSource = read("extensions/context-feed.ts");
  assert.match(source, /pi\.on\("before_agent_start"/);
  assert.match(source, /pi\.on\("tool_result"/);
  // ADR-0022: continuation uses the agent_end steering channel only — never
  // preflight tool_call hooks and never a fixed stall threshold.
  assert.match(source, /pi\.on\("agent_end"/);
  assert.doesNotMatch(source, /pi\.on\("tool_call"|STALL_THRESHOLD/);
  assert.doesNotMatch(source, /messages\.splice/);
  assert.doesNotMatch(contextSource, /pi\.on\("context"|messages\.splice/);
});

test("context-feed session_start 不递归清点 cwd", () => {
  const contextSource = read("extensions/context-feed.ts");
  assert.doesNotMatch(contextSource, /discoverScopes|scopeCache|readdirSync/);
  assert.doesNotMatch(contextSource, /refreshOpenTopics/);
  assert.match(contextSource, /buildBoardDelivery\(participatingTopics, coverage\)/);
  assert.match(contextSource, /pi-harness-board-participation/);
  assert.match(contextSource, /pi\.on\("tool_result"/);
  assert.match(contextSource, /findKnowledgeScope/);
});
