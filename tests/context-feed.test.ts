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
let handlers: Record<string, (...args: any[]) => any>;
let sessionEntries: Array<{ type: string; data: any }>;
let board: typeof import("../core/board/index.ts");

before(async () => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-context-feed-test-")));
  workspaceDir = join(sandbox, "exp");
  projectDir = join(workspaceDir, "a");
  const home = join(sandbox, "home");
  mkdirSync(join(workspaceDir, ".git"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(home, { recursive: true });
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
  const extension = (await import(`../extensions/context-feed.ts?test=${Date.now()}`)).default;
  await extension({
    on(name: string, handler: (...args: any[]) => any) {
      handlers[name] = handler;
    },
    appendEntry(type: string, data: any) {
      sessionEntries.push({ type, data });
    },
  });
  await handlers.session_start({}, {});
});

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(sandbox, { recursive: true, force: true });
});

function runtimeContext(window: number): any {
  return {
    model: { id: "test-model", contextWindow: window },
    getContextUsage: () => ({ tokens: 0, contextWindow: window, percent: 0 }),
  };
}

async function startTurn(prompt = "question", window = 1_000_000): Promise<any> {
  return handlers.before_agent_start({ prompt, systemPrompt: "system" }, runtimeContext(window));
}

function customFrom(result: any): any[] {
  if (!result?.message) return [];
  return [{ role: "custom", ...result.message, timestamp: Date.now() }];
}

async function acknowledgeCritical(result: any): Promise<void> {
  if (!result?.message) return;
  await handlers.message_end({
    message: { role: "custom", ...result.message, timestamp: Date.now() },
  });
}

test("按 project + workspace + global 分层注入，不扫描兄弟项目", async () => {
  const siblingKnowledge = join(workspaceDir, "b", "knowledge");
  mkdirSync(siblingKnowledge, { recursive: true });
  writeFileSync(join(siblingKnowledge, "index.md"), "sibling.md | MUST-NOT-INJECT\n", "utf-8");

  const beforeResult = await startTurn();
  assert.equal(beforeResult.message.customType, "pi-harness-board-critical");
  assert.equal(beforeResult.message.display, true);
  assert.match(beforeResult.message.content, /Board complete-context#12/);
  assert.match(beforeResult.message.content, /LAST-CRITICAL-/);
  assert.doesNotMatch(beforeResult.message.content, /FIRST-NOTE-/);

  const user = { role: "user", content: [{ type: "text", text: "question" }] };
  const event = { messages: [user, ...customFrom(beforeResult)] };
  const originalEvent = JSON.stringify(event);
  const result = await handlers.context(event, runtimeContext(1_000_000));

  assert.equal(JSON.stringify(event), originalEvent, "context hook must not rewrite the real user message");
  assert.equal(result.messages[0].role, "custom");
  assert.equal(result.messages[0].customType, "pi-harness-reference");
  assert.strictEqual(result.messages[1], user);
  const reference = result.messages[0].content as string;
  assert.match(reference, /reference_context/);
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
  await acknowledgeCritical(beforeResult);
});

test("同一用户轮次冻结 reference；下一用户轮次刷新", async () => {
  const first = await handlers.context(
    { messages: [{ role: "user", content: "question" }] },
    runtimeContext(1_000_000),
  );
  const frozen = first.messages[0].content as string;

  board.postNote("complete-context", "worker", "NEW-MID-LOOP-NOTE");
  board.postNote("complete-context", "human", "NEW-MID-LOOP-CRITICAL", { priority: "critical" });

  const second = await handlers.context(
    { messages: [{ role: "user", content: "question" }] },
    runtimeContext(1_000_000),
  );
  assert.equal(second.messages[0].content, frozen);
  assert.doesNotMatch(second.messages[0].content, /NEW-MID-LOOP/);

  const nextBefore = await startTurn("next question");
  assert.match(nextBefore.message.content, /Board complete-context#14/);
  assert.match(nextBefore.message.content, /NEW-MID-LOOP-CRITICAL/);
  assert.doesNotMatch(nextBefore.message.content, /LAST-CRITICAL-/);
  await acknowledgeCritical(nextBefore);

  const third = await handlers.context(
    { messages: [{ role: "user", content: "next question" }, ...customFrom(nextBefore)] },
    runtimeContext(1_000_000),
  );
  const refreshed = third.messages[0].content as string;
  assert.notEqual(refreshed, frozen);
  assert.match(refreshed, /NEW-MID-LOOP-NOTE/);
  assert.doesNotMatch(refreshed, /NEW-MID-LOOP-CRITICAL/);
});

test("达到模型窗口 20% 时只告警一次且保留全文", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    await startTurn("small-window", 1_000);
    const first = await handlers.context(
      { messages: [{ role: "user", content: "small-window" }] },
      runtimeContext(1_000),
    );
    assert.match(first.messages[0].content, /END-LARGE-DESCRIPTION/);
    assert.match(first.messages[0].content, /NEW-MID-LOOP-NOTE/);

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

test("session resume 从持久消息恢复 CRITICAL 已读集合", async () => {
  await handlers.session_start(
    { reason: "resume" },
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "custom_message",
            customType: "pi-harness-board-critical",
            details: { sources: ["Board complete-context#12", "Board complete-context#14"] },
          },
        ],
      },
    },
  );

  const result = await startTurn("resumed");
  assert.equal(result, undefined);
});
