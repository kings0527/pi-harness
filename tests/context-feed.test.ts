import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalCwd: string;
let originalHome: string | undefined;
let sandbox: string;
let workspaceDir: string;
let projectDir: string;
let projectKnowledgeRoot: string;
let featureDir: string;
let handlers: Record<string, Array<(...args: any[]) => any>>;
let sessionEntries: Array<{ type: string; data: any }>;
let contextEntries: any[];
let board: typeof import("../core/board/index.ts");

before(async () => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-context-feed-test-")));
  workspaceDir = join(sandbox, "exp");
  projectDir = join(workspaceDir, "a");
  featureDir = join(projectDir, "src", "feature");
  const home = join(sandbox, "home");
  mkdirSync(join(workspaceDir, ".git"), { recursive: true });
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspaceDir, "KNOWLEDGE.md"),
    "## Areas\n- a/src/feature/KNOWLEDGE.md | feature guidance\n",
    "utf-8",
  );
  writeFileSync(join(featureDir, "KNOWLEDGE.md"), "LAZY-SCOPE-MARKER\n", "utf-8");
  writeFileSync(join(featureDir, "index.ts"), "export {};\n", "utf-8");
  process.env.HOME = home;
  process.chdir(projectDir);
  projectKnowledgeRoot = join(projectDir, "knowledge");

  const knowledge = await import("../core/knowledge/index.ts");
  knowledge.addEntry(
    "project/large-index-row.md",
    "Project detail.",
    "topic-context#seq-1",
    `BEGIN-LARGE-DESCRIPTION-${"x".repeat(5000)}-END-LARGE-DESCRIPTION`,
  );
  knowledge.addEntry(
    "shared/workspace.md",
    "Workspace detail.",
    "topic-context#seq-2",
    "workspace index row",
    "workspace",
  );
  knowledge.addEntry(
    "shared/global.md",
    "Global detail.",
    "topic-context#seq-3",
    "global index row",
    "global",
  );

  board = await import("../core/board/index.ts");
  board.openTopic("complete-context", "Verify complete context delivery");
  board.postNote("complete-context", "planner", `FIRST-NOTE-${"a".repeat(1200)}`, { tags: ["plan"] });
  for (let i = 2; i <= 11; i++) {
    board.postNote("complete-context", `agent-${i}`, `MIDDLE-NOTE-${i}-${"m".repeat(300)}`);
  }
  board.postNote("complete-context", "reviewer", `LAST-CRITICAL-${"z".repeat(1200)}`, { priority: "critical" });

  handlers = {};
  sessionEntries = [];
  contextEntries = [];
  const extension = (await import(`../extensions/context-feed.ts?test=${Date.now()}`)).default;
  await extension({
    on(name: string, handler: (...args: any[]) => any) {
      (handlers[name] ??= []).push(handler);
    },
    appendEntry(type: string, data: any) {
      sessionEntries.push({ type, data });
    },
  });
  await fire("session_start", {}, runtimeContext(1_000_000));
});

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(sandbox, { recursive: true, force: true });
});

function runtimeContext(window: number): any {
  return {
    sessionManager: {
      getSessionId: () => "context-feed-session",
      buildContextEntries: () => contextEntries,
      getBranch: () => contextEntries,
    },
    model: { id: "test-model", contextWindow: window },
    getContextUsage: () => ({ tokens: 0, contextWindow: window, percent: 0 }),
  };
}

async function fire(name: string, event: any, ctx: any): Promise<any[]> {
  const results = [];
  for (const handler of handlers[name] ?? []) results.push(await handler(event, ctx));
  return results;
}

async function startTurn(prompt = "question", window = 1_000_000): Promise<any[]> {
  const results = await fire(
    "before_agent_start",
    { prompt, systemPrompt: "system" },
    runtimeContext(window),
  );
  contextEntries.push({
    type: "message",
    message: { role: "user", content: prompt, timestamp: Date.now() },
  });
  for (const result of results) {
    if (!result?.message) continue;
    contextEntries.push({
      type: "custom_message",
      ...result.message,
      timestamp: new Date().toISOString(),
    });
  }
  return results;
}

function messageOf(results: any[], customType: string): any | undefined {
  return results
    .flatMap(result => result?.message ? [result.message] : [])
    .find(message => message.customType === customType);
}

async function acknowledgeCritical(results: any[]): Promise<void> {
  const message = messageOf(results, "pi-harness-board-critical");
  if (!message) return;
  await fire("message_end", {
    message: { role: "custom", ...message, timestamp: Date.now() },
  }, runtimeContext(1_000_000));
}

test("按 project + workspace + global 分层注入，不扫描兄弟项目", async () => {
  const siblingKnowledge = join(workspaceDir, "b", "knowledge");
  mkdirSync(siblingKnowledge, { recursive: true });
  writeFileSync(join(siblingKnowledge, "index.md"), "sibling.md | MUST-NOT-INJECT\n", "utf-8");

  const results = await startTurn();
  const referenceMessage = messageOf(results, "pi-harness-reference");
  const criticalMessage = messageOf(results, "pi-harness-board-critical");
  assert.ok(referenceMessage);
  assert.equal(referenceMessage.display, false);
  assert.ok(criticalMessage);
  assert.equal(criticalMessage.display, true);
  assert.match(criticalMessage.content, /Board complete-context#12/);
  assert.match(criticalMessage.content, /LAST-CRITICAL-/);
  assert.doesNotMatch(criticalMessage.content, /FIRST-NOTE-/);
  assert.equal(handlers.context, undefined, "persistent references must not be moved by a context hook");

  const reference = referenceMessage.content as string;
  assert.match(reference, /reference_context/);
  assert.match(reference, /knowledge-catalog:/);
  assert.match(reference, /a\/src\/feature\/KNOWLEDGE\.md \| feature guidance/);
  assert.match(reference, /Indexes and Areas are locators/);
  assert.doesNotMatch(reference, /LAZY-SCOPE-MARKER/);
  assert.match(reference, /knowledge\(project:/);
  assert.match(reference, /knowledge\(workspace:/);
  assert.match(reference, /knowledge\(global:/);
  assert.match(reference, /BEGIN-LARGE-DESCRIPTION/);
  assert.match(reference, /END-LARGE-DESCRIPTION/);
  assert.match(reference, /workspace index row/);
  assert.match(reference, /global index row/);
  assert.match(reference, /FIRST-NOTE-/);
  assert.match(reference, /MIDDLE-NOTE-2-/);
  assert.match(reference, /MIDDLE-NOTE-11-/);
  assert.doesNotMatch(reference, /LAST-CRITICAL-/);
  assert.doesNotMatch(reference, /MUST-NOT-INJECT/);
  assert.doesNotMatch(reference, /earlier notes omitted/i);

  const snapshotEntry = sessionEntries.at(-1)!;
  assert.equal(snapshotEntry.type, "pi-harness-context-snapshot");
  assert.equal(readFileSync(snapshotEntry.data.path, "utf-8"), reference);
  assert.equal(createHash("sha256").update(reference).digest("hex"), snapshotEntry.data.snapshotId);
  await acknowledgeCritical(results);
});

test("相同 reference 不重复追加；变化时追加新快照且保留旧 request 前缀", async () => {
  const frozen = contextEntries.find(
    entry => entry.type === "custom_message" && entry.customType === "pi-harness-reference",
  ).content as string;

  const beforeUnchanged = structuredClone(contextEntries);
  const unchanged = await startTurn("same sources");
  assert.equal(messageOf(unchanged, "pi-harness-reference"), undefined);
  assert.deepEqual(contextEntries.slice(0, beforeUnchanged.length), beforeUnchanged);

  board.postNote("complete-context", "worker", "NEW-MID-LOOP-NOTE");
  board.postNote("complete-context", "human", "NEW-MID-LOOP-CRITICAL", { priority: "critical" });

  const cachedPrefix = structuredClone(contextEntries);
  const changed = await startTurn("next question");
  assert.deepEqual(contextEntries.slice(0, cachedPrefix.length), cachedPrefix);
  const refreshed = messageOf(changed, "pi-harness-reference").content as string;
  assert.notEqual(refreshed, frozen);
  assert.match(refreshed, /NEW-MID-LOOP-NOTE/);
  assert.doesNotMatch(refreshed, /NEW-MID-LOOP-CRITICAL/);
  const critical = messageOf(changed, "pi-harness-board-critical");
  assert.match(critical.content, /Board complete-context#14/);
  assert.match(critical.content, /NEW-MID-LOOP-CRITICAL/);
  assert.doesNotMatch(critical.content, /LAST-CRITICAL-/);
  await acknowledgeCritical(changed);

  const referenceCount = contextEntries.filter(
    entry => entry.type === "custom_message" && entry.customType === "pi-harness-reference",
  ).length;
  assert.equal(referenceCount, 2);
});

test("达到模型窗口 20% 时只告警一次且保留全文", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    await startTurn("small-window", 1_000);
    const latestReference = [...contextEntries].reverse().find(
      (entry: any) => entry.type === "custom_message" && entry.customType === "pi-harness-reference",
    );
    assert.match(latestReference.content, /END-LARGE-DESCRIPTION/);
    assert.match(latestReference.content, /NEW-MID-LOOP-NOTE/);

    await startTurn("small-window-again", 1_000);
  } finally {
    console.error = originalError;
  }

  const sizeWarnings = errors.filter(line => line.includes("Full context preserved"));
  assert.equal(sizeWarnings.length, 1);
  assert.match(sizeWarnings[0], /stale, incorrect, duplicate, or overly verbose/);
});

test("过期 index 行触发健康提醒但不自动删除", async () => {
  const indexPath = join(projectKnowledgeRoot, "index.md");
  const beforeText = readFileSync(indexPath, "utf-8");
  writeFileSync(indexPath, `${beforeText}missing/obsolete.md | obsolete row\n`, "utf-8");

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    await startTurn("health-check");
  } finally {
    console.error = originalError;
  }

  assert.ok(errors.some(line => line.includes("project:missing/obsolete.md (missing)")));
  assert.match(readFileSync(indexPath, "utf-8"), /missing\/obsolete\.md \| obsolete row/);
  writeFileSync(indexPath, beforeText, "utf-8");
});

test("文件访问后在下一轮披露最近的目录级 knowledge 正文", async () => {
  await fire(
    "tool_call",
    { tool: "read", input: { path: join(featureDir, "index.ts") } },
    runtimeContext(1_000_000),
  );

  const results = await startTurn("scope activated");
  const reference = messageOf(results, "pi-harness-reference");
  assert.ok(reference);
  assert.match(reference.content, /scope\(a\/src\/feature\):/);
  assert.match(reference.content, /LAZY-SCOPE-MARKER/);
});

test("session resume 从持久消息恢复 CRITICAL 已读集合", async () => {
  await fire(
    "session_start",
    { reason: "resume" },
    runtimeContext(1_000_000),
  );

  const results = await startTurn("resumed");
  assert.equal(messageOf(results, "pi-harness-board-critical"), undefined);
  const reference = messageOf(results, "pi-harness-reference");
  assert.ok(reference);
  assert.match(reference.content, /knowledge-catalog:/);
  assert.match(reference.content, /a\/src\/feature\/KNOWLEDGE\.md \| feature guidance/);
  assert.doesNotMatch(reference.content, /LAZY-SCOPE-MARKER/);
});
