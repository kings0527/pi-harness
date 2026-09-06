import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boardCriticalKey,
  buildBoardDelivery,
  deriveBoardCoverage,
} from "../core/context-reference/index.ts";

let originalCwd: string;
let originalHome: string | undefined;
let originalCatalogLimit: string | undefined;
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
  originalCatalogLimit = process.env.PI_BOARD_CATALOG_MAX_TOPICS;
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
  // P0 is catalog-only by default. Existing fixture tests exercise a joined
  // work topic explicitly; separate tests below assert unjoined isolation.
  await fire("tool_result", {
    tool: "board",
    input: { action: "participate", topic: "complete-context", mode: "join", reason: "fixture" },
    result: { ok: true },
  }, runtimeContext(1_000_000));
});

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCatalogLimit === undefined) delete process.env.PI_BOARD_CATALOG_MAX_TOPICS;
  else process.env.PI_BOARD_CATALOG_MAX_TOPICS = originalCatalogLimit;
  rmSync(sandbox, { recursive: true, force: true });
});

function runtimeContext(window: number, id = "context-feed-session", entries = contextEntries): any {
  return {
    sessionManager: {
      getSessionId: () => id,
      buildContextEntries: () => entries,
      getBranch: () => entries,
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

async function joinTopic(topic: string, action: "open" | "post" = "post"): Promise<void> {
  await fire("tool_result", {
    tool: "board",
    input: { action, topic },
    result: { ok: true },
  }, runtimeContext(1_000_000));
}

async function participate(topic: string, mode: "join" | "watch" | "defer", reason = "test"): Promise<void> {
  await fire("tool_result", {
    tool: "board",
    input: { action: "participate", topic, mode, reason },
    result: { ok: true },
  }, runtimeContext(1_000_000));
}

test("按 project + workspace + global 分层注入，不扫描兄弟项目", async () => {
  const siblingKnowledge = join(workspaceDir, "b", "knowledge");
  mkdirSync(siblingKnowledge, { recursive: true });
  writeFileSync(join(siblingKnowledge, "index.md"), "sibling.md | MUST-NOT-INJECT\n", "utf-8");

  const results = await startTurn();
  const knowledgeMessage = messageOf(results, "pi-harness-knowledge-reference");
  const boardCheckpoint = messageOf(results, "pi-harness-board-checkpoint");
  const criticalMessage = messageOf(results, "pi-harness-board-critical");
  assert.ok(knowledgeMessage);
  assert.equal(knowledgeMessage.display, false);
  assert.ok(boardCheckpoint);
  assert.equal(boardCheckpoint.display, false);
  assert.ok(criticalMessage);
  assert.equal(criticalMessage.display, true);
  assert.match(criticalMessage.content, /Board complete-context#12/);
  assert.match(criticalMessage.content, /LAST-CRITICAL-/);
  assert.doesNotMatch(criticalMessage.content, /FIRST-NOTE-/);
  assert.equal(handlers.context, undefined, "persistent references must not be moved by a context hook");

  const knowledgeReference = knowledgeMessage.content as string;
  assert.match(knowledgeReference, /knowledge_reference/);
  assert.match(knowledgeReference, /knowledge-catalog:/);
  assert.match(knowledgeReference, /a\/src\/feature\/KNOWLEDGE\.md \| feature guidance/);
  assert.match(knowledgeReference, /Indexes and Areas are locators/);
  assert.doesNotMatch(knowledgeReference, /LAZY-SCOPE-MARKER/);
  assert.match(knowledgeReference, /knowledge\(project:/);
  assert.match(knowledgeReference, /knowledge\(workspace:/);
  assert.match(knowledgeReference, /knowledge\(global:/);
  assert.match(knowledgeReference, /BEGIN-LARGE-DESCRIPTION/);
  assert.match(knowledgeReference, /END-LARGE-DESCRIPTION/);
  assert.match(knowledgeReference, /workspace index row/);
  assert.match(knowledgeReference, /global index row/);
  assert.doesNotMatch(knowledgeReference, /MUST-NOT-INJECT/);

  const boardReference = boardCheckpoint.content as string;
  assert.match(boardReference, /board_checkpoint/);
  assert.match(boardReference, /FIRST-NOTE-/);
  assert.match(boardReference, /MIDDLE-NOTE-2-/);
  assert.match(boardReference, /MIDDLE-NOTE-11-/);
  assert.doesNotMatch(boardReference, /LAST-CRITICAL-/);
  assert.doesNotMatch(boardReference, /earlier notes omitted/i);

  for (const [kind, content] of [
    ["knowledge", knowledgeReference],
    ["board-checkpoint", boardReference],
    ["board-critical", criticalMessage.content as string],
  ] as const) {
    const snapshotEntry = sessionEntries.find(entry => entry.data.kind === kind)!;
    assert.equal(snapshotEntry.type, "pi-harness-context-snapshot");
    assert.equal(readFileSync(snapshotEntry.data.path, "utf-8"), content);
    assert.equal(createHash("sha256").update(content).digest("hex"), snapshotEntry.data.snapshotId);
  }
  await acknowledgeCritical(results);
});

test("升级时把 active legacy reference 视为 checkpoint，避免重复整块 Board", async () => {
  const preservedEntries = contextEntries;
  const topic = "legacy-checkpoint-migration";
  board.openTopic(topic, "exercise legacy checkpoint migration");
  board.postNote(topic, "old-agent", "LEGACY-ALREADY-PRESENT");
  await joinTopic(topic);
  const topicSeqs = Object.fromEntries(
    board.listOpenTopics().map(open => {
      const notes = board.readNotes(open.id);
      return [open.id, notes.at(-1)?.seq ?? 0];
    }),
  );
  const snapshotId = "legacy-snapshot-fixture";
  contextEntries = [
    {
      type: "custom",
      customType: "pi-harness-context-snapshot",
      data: { snapshotId, topicSeqs, boardBytes: 12_345 },
    },
    {
      type: "custom_message",
      customType: "pi-harness-reference",
      content: "legacy combined knowledge + complete Board snapshot",
      details: { snapshotId, state: "active" },
    },
  ];
  try {
    board.postNote(topic, "new-agent", "LEGACY-MIGRATION-DELTA");
    const results = await startTurn("first turn after ADR-0018 upgrade");
    assert.equal(messageOf(results, "pi-harness-board-checkpoint"), undefined);
    const delta = messageOf(results, "pi-harness-board-delta");
    assert.ok(delta);
    assert.match(delta.content, /LEGACY-MIGRATION-DELTA/);
    assert.doesNotMatch(delta.content, /LEGACY-ALREADY-PRESENT/);
  } finally {
    board.closeTopic(topic);
    contextEntries = preservedEntries;
  }
});

test("legacy checkpoint 遇到已归档同 ID 的新 incarnation 时全量重显且修正 cursor", async () => {
  const preservedEntries = contextEntries;
  const topic = "legacy-reused-context-topic";
  board.openTopic(topic, "first incarnation");
  for (let seq = 1; seq <= 5; seq += 1) {
    board.postNote(
      topic,
      "old-agent",
      `OLD-INCARNATION-${seq}`,
      seq === 1 ? { priority: "critical" } : undefined,
    );
  }
  board.closeTopic(topic);

  const topicsPath = join(projectDir, ".pi-board", "topics");
  const activeCreatedAt = Date.now() + 1;
  writeFileSync(
    join(topicsPath, `${topic}.jsonl`),
    [
      `#META#${JSON.stringify({
        id: topic,
        goal: "second active incarnation",
        status: "open",
        createdAt: activeCreatedAt,
      })}`,
      JSON.stringify({
        seq: 1,
        author: "new-agent",
        timestamp: Date.now(),
        content: "NEW-INCARNATION-CRITICAL-MUST-BE-VISIBLE",
        priority: "critical",
      }),
      JSON.stringify({
        seq: 2,
        author: "new-agent",
        timestamp: Date.now(),
        content: "NEW-INCARNATION-MUST-BE-VISIBLE",
      }),
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(join(topicsPath, `${topic}.board.md`), "legacy reused active fixture\n", "utf-8");
  await joinTopic(topic);

  const snapshotId = "legacy-reused-snapshot-fixture";
  contextEntries = [
    {
      type: "custom",
      customType: "pi-harness-context-snapshot",
      data: { snapshotId, topicSeqs: { [topic]: 5 }, boardBytes: 100 },
    },
    {
      type: "custom_message",
      customType: "pi-harness-reference",
      content: "legacy first-incarnation checkpoint",
      details: { snapshotId, state: "active" },
    },
    {
      type: "custom_message",
      customType: "pi-harness-board-critical",
      content: "old incarnation critical already visible",
      details: { sources: [`Board ${topic}#1`] },
    },
  ];

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    const repaired = await startTurn("upgrade reused topic identity");
    const delta = messageOf(repaired, "pi-harness-board-delta");
    assert.ok(delta);
    assert.match(delta.content, /NEW-INCARNATION-MUST-BE-VISIBLE/);
    assert.doesNotMatch(delta.content, /NEW-INCARNATION-CRITICAL-MUST-BE-VISIBLE/);
    assert.doesNotMatch(delta.content, /OLD-INCARNATION-/);
    assert.equal(delta.details.topicSeqs[topic], 2);
    assert.equal(delta.details.topicIncarnations[topic], activeCreatedAt);
    assert.ok(errors.some(line => line.includes(`legacy reused topic ${topic} detected`)));
    const critical = messageOf(repaired, "pi-harness-board-critical");
    assert.ok(critical);
    assert.match(critical.content, /NEW-INCARNATION-CRITICAL-MUST-BE-VISIBLE/);
    assert.doesNotMatch(critical.content, /OLD-INCARNATION-1/);
    assert.ok(
      critical.details.criticalKeys.includes(boardCriticalKey(topic, activeCreatedAt, 1)),
    );

    const stable = await startTurn("incarnation cursor now stable");
    assert.equal(messageOf(stable, "pi-harness-board-delta"), undefined);
    assert.equal(messageOf(stable, "pi-harness-board-critical"), undefined);
  } finally {
    console.error = originalError;
    rmSync(join(topicsPath, `${topic}.jsonl`), { force: true });
    rmSync(join(topicsPath, `${topic}.board.md`), { force: true });
    for (const suffix of ["jsonl", "board.md", "summary.md", "decisions.md"]) {
      rmSync(join(topicsPath, "archive", `${topic}.${suffix}`), { force: true });
    }
    contextEntries = preservedEntries;
  }
});

test("相同来源不重复追加；Board 变化只追加 seq delta", async () => {
  const frozenKnowledge = contextEntries.find(
    entry => entry.type === "custom_message" && entry.customType === "pi-harness-knowledge-reference",
  ).content as string;

  const beforeUnchanged = structuredClone(contextEntries);
  const unchanged = await startTurn("same sources");
  assert.equal(messageOf(unchanged, "pi-harness-knowledge-reference"), undefined);
  assert.equal(messageOf(unchanged, "pi-harness-board-checkpoint"), undefined);
  assert.equal(messageOf(unchanged, "pi-harness-board-delta"), undefined);
  assert.deepEqual(contextEntries.slice(0, beforeUnchanged.length), beforeUnchanged);

  board.postNote("complete-context", "worker", "NEW-MID-LOOP-NOTE");
  board.postNote("complete-context", "human", "NEW-MID-LOOP-CRITICAL", { priority: "critical" });

  const cachedPrefix = structuredClone(contextEntries);
  const changed = await startTurn("next question");
  assert.deepEqual(contextEntries.slice(0, cachedPrefix.length), cachedPrefix);
  assert.equal(messageOf(changed, "pi-harness-knowledge-reference"), undefined);
  assert.equal(messageOf(changed, "pi-harness-board-checkpoint"), undefined);
  const delta = messageOf(changed, "pi-harness-board-delta").content as string;
  assert.match(delta, /board_delta/);
  assert.match(delta, /NEW-MID-LOOP-NOTE/);
  assert.doesNotMatch(delta, /FIRST-NOTE-/);
  assert.doesNotMatch(delta, /MIDDLE-NOTE-11-/);
  assert.doesNotMatch(delta, /NEW-MID-LOOP-CRITICAL/);
  const critical = messageOf(changed, "pi-harness-board-critical");
  assert.match(critical.content, /Board complete-context#14/);
  assert.match(critical.content, /NEW-MID-LOOP-CRITICAL/);
  assert.doesNotMatch(critical.content, /LAST-CRITICAL-/);
  await acknowledgeCritical(changed);

  assert.equal(contextEntries.filter(
    entry => entry.type === "custom_message" && entry.customType === "pi-harness-knowledge-reference",
  ).length, 1);
  assert.equal(contextEntries.filter(
    entry => entry.type === "custom_message" && entry.customType === "pi-harness-board-checkpoint",
  ).length, 1);
  assert.equal(contextEntries.filter(
    entry => entry.type === "custom_message" && entry.customType === "pi-harness-board-delta",
  ).length, 1);
  assert.equal(contextEntries.find(
    entry => entry.type === "custom_message" && entry.customType === "pi-harness-knowledge-reference",
  ).content, frozenKnowledge);
});

test("并发 before_agent_start 以本次 ctx 关联 Board/CRITICAL，不串用 session 单槽", async () => {
  assert.equal(handlers.before_agent_start.length, 4);
  const [plan, _deliverCatalog, deliverBoard, deliverCritical] = handlers.before_agent_start;
  const ctxA = runtimeContext(1_000_000);
  const ctxB = runtimeContext(1_000_000);

  board.postNote("complete-context", "agent-a", "INTERLEAVE-A-NOTE");
  board.postNote("complete-context", "agent-a", "INTERLEAVE-A-CRITICAL", { priority: "critical" });
  await plan({ prompt: "A", systemPrompt: "system" }, ctxA);

  board.postNote("complete-context", "agent-b", "INTERLEAVE-B-NOTE");
  board.postNote("complete-context", "agent-b", "INTERLEAVE-B-CRITICAL", { priority: "critical" });
  await plan({ prompt: "B", systemPrompt: "system" }, ctxB);

  const boardA = (await deliverBoard({}, ctxA))?.message;
  const boardB = (await deliverBoard({}, ctxB))?.message;
  const criticalA = (await deliverCritical({}, ctxA))?.message;
  const criticalB = (await deliverCritical({}, ctxB))?.message;
  assert.match(boardA.content, /INTERLEAVE-A-NOTE/);
  assert.doesNotMatch(boardA.content, /INTERLEAVE-B-NOTE/);
  assert.match(boardB.content, /INTERLEAVE-A-NOTE/);
  assert.match(boardB.content, /INTERLEAVE-B-NOTE/);
  assert.match(criticalA.content, /INTERLEAVE-A-CRITICAL/);
  assert.doesNotMatch(criticalA.content, /INTERLEAVE-B-CRITICAL/);
  assert.match(criticalB.content, /INTERLEAVE-A-CRITICAL/);
  assert.match(criticalB.content, /INTERLEAVE-B-CRITICAL/);

  // Persist the later invocation as Pi would, so following stateful fixtures
  // start from the newest cursor and announced CRITICAL set.
  for (const message of [boardB, criticalB]) {
    contextEntries.push({
      type: "custom_message",
      ...message,
      timestamp: new Date().toISOString(),
    });
  }
});

test("仅新增 CRITICAL 时不生成空 delta，可见消息携带 cursor", async () => {
  board.postNote("complete-context", "reviewer", "CRITICAL-ONLY-UPDATE", { priority: "critical" });
  const results = await startTurn("critical only");
  assert.equal(messageOf(results, "pi-harness-board-delta"), undefined);
  const critical = messageOf(results, "pi-harness-board-critical");
  assert.ok(critical);
  assert.match(critical.content, /CRITICAL-ONLY-UPDATE/);
  assert.equal(critical.details.topicSeqs["complete-context"], 19);
  await acknowledgeCritical(results);

  const next = await startTurn("critical already covered");
  assert.equal(messageOf(next, "pi-harness-board-delta"), undefined);
  assert.equal(messageOf(next, "pi-harness-board-critical"), undefined);
});

test("CRITICAL 可见消息不推进被动 Board cursor", () => {
  const coverage = deriveBoardCoverage([
    {
      mode: "checkpoint",
      topicSeqs: { "complete-context": 14 },
      topicStates: { "complete-context": "open" },
    },
    {
      mode: "critical",
      topicSeqs: { "complete-context": 15 },
      topicStates: { "complete-context": "open" },
    },
  ]);
  assert.equal(coverage.topicSeqs["complete-context"], 14);
});

test("catalog 首轮 checkpoint、后续仅追加变更 row；旧 catalog metadata 缺失时安全回退 checkpoint", async () => {
  const historical = contextEntries;
  const seed = "catalog-delta-seed";
  contextEntries = [];
  board.openTopic(seed, "catalog delta baseline");
  try {
    const first = await startTurn("catalog initial baseline");
    const firstCatalog = messageOf(first, "pi-harness-board-catalog");
    assert.ok(firstCatalog);
    assert.equal(firstCatalog.details.mode, "checkpoint");

    board.postNote(seed, "peer", "CATALOG-DELTA-ONLY");
    const changed = await startTurn("catalog one topic changes");
    const delta = messageOf(changed, "pi-harness-board-catalog");
    assert.ok(delta);
    assert.equal(delta.details.mode, "delta");
    assert.match(delta.content, /catalog-delta-seed/);
    assert.match(delta.content, /createdBy=/);
    assert.match(delta.content, /createdAt=/);
    assert.match(delta.content, /activity=/);
    assert.doesNotMatch(delta.content, /complete-context/);

    const prior = contextEntries;
    contextEntries = prior.filter(entry => entry.customType !== "pi-harness-board-catalog");
    const rebuilt = await startTurn("catalog checkpoint compacted away");
    const checkpoint = messageOf(rebuilt, "pi-harness-board-catalog");
    assert.ok(checkpoint);
    assert.equal(checkpoint.details.mode, "checkpoint");
    assert.match(checkpoint.content, /complete-context/);
    assert.match(checkpoint.content, /catalog-delta-seed/);
  } finally {
    contextEntries = historical;
    board.closeTopic(seed);
  }
});

test("catalog row cap fail-loud，不投递静默截断的部分 catalog", async () => {
  const topic = "catalog-cap-topic";
  board.openTopic(topic, "catalog cap fixture");
  const previous = process.env.PI_BOARD_CATALOG_MAX_TOPICS;
  process.env.PI_BOARD_CATALOG_MAX_TOPICS = "1";
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    const results = await startTurn("catalog over explicit cap");
    assert.equal(messageOf(results, "pi-harness-board-catalog"), undefined);
    assert.ok(errors.some(line => line.includes("Board delivery notice")));
  } finally {
    console.error = originalError;
    if (previous === undefined) delete process.env.PI_BOARD_CATALOG_MAX_TOPICS;
    else process.env.PI_BOARD_CATALOG_MAX_TOPICS = previous;
    board.closeTopic(topic);
  }
});

test("open topic 正文损坏时延后首次 checkpoint，不声明空 Board", () => {
  const path = join(projectDir, ".pi-board", "topics", "corrupt-topic.jsonl");
  writeFileSync(
    path,
    `#META#${JSON.stringify({
      id: "corrupt-topic",
      goal: "exercise incomplete topic read",
      status: "open",
      createdAt: Date.now(),
    })}\n{not-json}\n`,
    "utf-8",
  );
  try {
    const delivery = buildBoardDelivery(new Set(["corrupt-topic"]), {
      hasCheckpoint: false,
      topicSeqs: {},
      topicStates: {},
      topicIncarnations: {},
    });
    assert.equal(delivery.mode, "none");
    assert.equal(delivery.content, "");
    // ADR-0020: listOpenTopics now validates full bodies up front, so the
    // failure surfaces at listing time instead of per-topic snapshot reads.
    assert.deepEqual(delivery.warnings, [
      'open-topic listing failed: Topic "corrupt-topic" JSONL is corrupted: line 2 is not valid JSON',
    ]);
  } finally {
    rmSync(path, { force: true });
  }
});

test("达到模型窗口 20% 时只告警一次且保留全文", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    await startTurn("small-window", 1_000);
    const latestKnowledge = [...contextEntries].reverse().find(
      (entry: any) => entry.type === "custom_message" && entry.customType === "pi-harness-knowledge-reference",
    );
    const latestBoardDelta = [...contextEntries].reverse().find(
      (entry: any) => entry.type === "custom_message" && entry.customType === "pi-harness-board-delta",
    );
    assert.match(latestKnowledge.content, /END-LARGE-DESCRIPTION/);
    assert.match(latestBoardDelta.content, /INTERLEAVE-B-NOTE/);

    await startTurn("small-window-again", 1_000);
  } finally {
    console.error = originalError;
  }

  const sizeWarnings = errors.filter(line => line.includes("Full context preserved"));
  assert.equal(sizeWarnings.length, 1);
  const breakdown = sizeWarnings[0].match(
    /~(\d+) tokens .* current knowledge ~(\d+), active Board references ~(\d+), retained runtime references ~(\d+)/,
  );
  assert.ok(breakdown);
  const [total, knowledgeTokens, boardTokens, retainedTokens] = breakdown.slice(1).map(Number);
  assert.ok(
    Math.abs(total - knowledgeTokens - boardTokens - retainedTokens) <= 3,
    `warning breakdown must be disjoint: ${sizeWarnings[0]}`,
  );
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
  const reference = messageOf(results, "pi-harness-knowledge-reference");
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
  assert.equal(messageOf(results, "pi-harness-board-checkpoint"), undefined);
  assert.equal(messageOf(results, "pi-harness-board-delta"), undefined);
  const reference = messageOf(results, "pi-harness-knowledge-reference");
  assert.ok(reference);
  assert.match(reference.content, /knowledge-catalog:/);
  assert.match(reference.content, /a\/src\/feature\/KNOWLEDGE\.md \| feature guidance/);
  assert.doesNotMatch(reference.content, /LAZY-SCOPE-MARKER/);
});

test("压缩使 active checkpoint 缺失时重发完整 Board，不依赖历史 branch", async () => {
  const historical = contextEntries;
  contextEntries = historical.filter(entry => entry.type === "message").slice(-2);

  const results = await startTurn("after compaction");
  const checkpoint = messageOf(results, "pi-harness-board-checkpoint");
  assert.ok(checkpoint);
  assert.match(checkpoint.content, /FIRST-NOTE-/);
  assert.match(checkpoint.content, /NEW-MID-LOOP-NOTE/);
  assert.doesNotMatch(checkpoint.content, /LAST-CRITICAL-/);
  const critical = messageOf(results, "pi-harness-board-critical");
  assert.ok(critical);
  assert.match(critical.content, /LAST-CRITICAL-/);
  assert.match(critical.content, /NEW-MID-LOOP-CRITICAL/);
  assert.match(critical.content, /CRITICAL-ONLY-UPDATE/);

  const frozen = sessionEntries.find(
    entry => entry.data.kind === "board-critical" && entry.data.snapshotId === critical.details.snapshotId,
  )!;
  assert.equal(readFileSync(frozen.data.path, "utf-8"), critical.content);
  assert.equal(createHash("sha256").update(critical.content).digest("hex"), frozen.data.snapshotId);
});

test("branch 只保留 checkpoint 时，缺失的 CRITICAL 正文会重显", async () => {
  contextEntries = contextEntries.filter(
    entry => entry.customType !== "pi-harness-board-critical",
  );

  const results = await startTurn("critical branch recovery");
  assert.equal(messageOf(results, "pi-harness-board-checkpoint"), undefined);
  assert.equal(messageOf(results, "pi-harness-board-delta"), undefined);
  const critical = messageOf(results, "pi-harness-board-critical");
  assert.ok(critical);
  assert.match(critical.content, /LAST-CRITICAL-/);
  assert.match(critical.content, /NEW-MID-LOOP-CRITICAL/);
  assert.match(critical.content, /CRITICAL-ONLY-UPDATE/);
});

test("失败的 Board mutation 保持 catalog-only，不伪造 join", async () => {
  const topic = "failed-board-join";
  board.openTopic(topic, "failed mutations are not participation evidence");
  board.postNote(topic, "peer", "FAILED-RESULT-MUST-STAY-METADATA-ONLY");
  const entriesBeforeResult = sessionEntries.length;
  await fire("tool_result", {
    tool: "board",
    input: { action: "post", topic },
    isError: true,
  }, runtimeContext(1_000_000));
  assert.equal(sessionEntries.length, entriesBeforeResult, "failed mutation must not directly persist participation");

  const results = await startTurn("failed Board mutation");
  const catalog = messageOf(results, "pi-harness-board-catalog");
  assert.ok(catalog);
  assert.match(catalog.content, /failed-board-join/);
  assert.doesNotMatch(catalog.content, /FAILED-RESULT-MUST-STAY-METADATA-ONLY/);
  assert.equal(messageOf(results, "pi-harness-board-delta"), undefined);
  board.closeTopic(topic);
});

test("watch/defer 只看 metadata；peer 后开 topic 先 catalog 可见，显式 join 后才接收完整正文和 delta", async () => {
  board.openTopic("watch-topic", "Watch must remain metadata-only");
  board.postNote("watch-topic", "other-agent", "WATCH-BODY-MUST-NOT-LEAK", { priority: "critical" });
  await participate("watch-topic", "watch", "potential dependency");
  const watched = await startTurn("watch peer topic");
  const watchCatalog = messageOf(watched, "pi-harness-board-catalog");
  assert.match(watchCatalog.content, /watch-topic/);
  assert.match(watchCatalog.content, /critical=1/);
  assert.doesNotMatch(watchCatalog.content, /WATCH-BODY-MUST-NOT-LEAK/);
  assert.equal(messageOf(watched, "pi-harness-board-critical"), undefined);
  await participate("watch-topic", "defer", "not currently relevant");
  board.postNote("watch-topic", "other-agent", "DEFER-BODY-MUST-NOT-LEAK");
  const deferred = await startTurn("defer peer topic");
  const deferCatalog = messageOf(deferred, "pi-harness-board-catalog");
  assert.match(deferCatalog.content, /watch-topic \[defer;/);
  assert.doesNotMatch(deferCatalog.content, /DEFER-BODY-MUST-NOT-LEAK/);

  board.openTopic("cross-agent-topic", "Cross-agent synchronization");
  board.postNote("cross-agent-topic", "other-agent", "CROSS-AGENT-FIRST-NOTE");

  const discovered = await startTurn("discover peer-created topic");
  const catalog = messageOf(discovered, "pi-harness-board-catalog");
  assert.ok(catalog);
  assert.match(catalog.content, /cross-agent-topic/);
  assert.doesNotMatch(catalog.content, /CROSS-AGENT-FIRST-NOTE/);
  assert.equal(messageOf(discovered, "pi-harness-board-delta"), undefined);

  await participate("cross-agent-topic", "join", "same acceptance criterion");
  const joined = await startTurn("join peer topic");
  const opened = messageOf(joined, "pi-harness-board-delta");
  assert.ok(opened);
  assert.match(opened.content, /topic_opened/);
  assert.match(opened.content, /CROSS-AGENT-FIRST-NOTE/);

  board.postNote("cross-agent-topic", "other-agent", "CROSS-AGENT-SECOND-NOTE");
  const updated = await startTurn("observe joined peer update");
  const delta = messageOf(updated, "pi-harness-board-delta");
  assert.ok(delta);
  assert.match(delta.content, /CROSS-AGENT-SECOND-NOTE/);
  assert.doesNotMatch(delta.content, /CROSS-AGENT-FIRST-NOTE/);
});

test("已覆盖 topic 关闭后只追加 tombstone", async () => {
  board.closeTopic("cross-agent-topic");
  const results = await startTurn("observe close");
  const delta = messageOf(results, "pi-harness-board-delta");
  assert.ok(delta);
  assert.match(delta.content, /topic_closed/);
  assert.match(delta.content, /cross-agent-topic/);
  assert.doesNotMatch(delta.content, /CROSS-AGENT-FIRST-NOTE/);
});

test("peer 在两轮间 post 后 close 时先补齐 archive final delta/CRITICAL 再 tombstone", async () => {
  const topic = "close-with-unseen-final-notes";
  board.openTopic(topic, "deliver final notes before closure");
  board.postNote(topic, "peer", "CLOSE-BASELINE-NOTE");
  await joinTopic(topic);
  const opened = await startTurn("observe topic before peer close");
  assert.match(messageOf(opened, "pi-harness-board-delta").content, /CLOSE-BASELINE-NOTE/);

  board.postNote(topic, "peer", "CLOSE-FINAL-NONCRITICAL");
  board.postNote(topic, "peer", "CLOSE-FINAL-CRITICAL", { priority: "critical" });
  board.closeTopic(topic);

  const closed = await startTurn("observe peer final post and close");
  const delta = messageOf(closed, "pi-harness-board-delta");
  assert.ok(delta);
  assert.match(delta.content, /CLOSE-FINAL-NONCRITICAL/);
  assert.match(delta.content, /topic_closed/);
  assert.match(delta.content, new RegExp(topic));
  assert.doesNotMatch(delta.content, /CLOSE-BASELINE-NOTE/);
  assert.doesNotMatch(delta.content, /CLOSE-FINAL-CRITICAL/);
  const critical = messageOf(closed, "pi-harness-board-critical");
  assert.ok(critical);
  assert.match(critical.content, /CLOSE-FINAL-CRITICAL/);

  const stable = await startTurn("closed final delta already covered");
  assert.equal(messageOf(stable, "pi-harness-board-delta"), undefined);
  assert.equal(messageOf(stable, "pi-harness-board-critical"), undefined);

  contextEntries = contextEntries.filter(entry => !(
    entry.type === "custom_message"
      && entry.customType === "pi-harness-board-critical"
      && entry.details?.sources?.includes(`Board ${topic}#3`)
  ));
  const recovered = await startTurn("closing CRITICAL was compacted away");
  assert.equal(messageOf(recovered, "pi-harness-board-delta"), undefined);
  assert.match(
    messageOf(recovered, "pi-harness-board-critical").content,
    /CLOSE-FINAL-CRITICAL/,
  );
  const recoveredStable = await startTurn("closing CRITICAL recovery persisted");
  assert.equal(messageOf(recoveredStable, "pi-harness-board-critical"), undefined);

  const afterFullBoardCompaction = buildBoardDelivery(new Set([topic]), {
    hasCheckpoint: false,
    topicSeqs: {},
    topicStates: {},
    topicIncarnations: {},
  });
  assert.equal(afterFullBoardCompaction.mode, "checkpoint");
  assert.equal(afterFullBoardCompaction.topicStates[topic], "closed");
  assert.equal(afterFullBoardCompaction.topicSeqs[topic], 3);
  assert.ok(afterFullBoardCompaction.criticalUpdates.some(
    update => update.topic === topic && update.note.content === "CLOSE-FINAL-CRITICAL",
  ));
});

test("同进程另一 session 启动不会清掉当前 session 的已参与 topic", async () => {
  const topic = "session-isolated-board-state";
  const entriesA: any[] = [];
  const entriesB: any[] = [];
  const ctxA = runtimeContext(1_000_000, "board-session-a", entriesA);
  const ctxB = runtimeContext(1_000_000, "board-session-b", entriesB);
  const persist = (entries: any[], results: any[]) => {
    for (const result of results) {
      if (!result?.message) continue;
      entries.push({ type: "custom_message", ...result.message, timestamp: new Date().toISOString() });
    }
  };

  await fire("session_start", {}, ctxA);
  board.openTopic(topic, "prove session-local Board feed state");
  board.postNote(topic, "peer", "SESSION-A-OPEN-NOTE");
  await fire("tool_result", { tool: "board", input: { action: "participate", topic, mode: "join" }, result: { ok: true } }, ctxA);
  persist(entriesA, await fire(
    "before_agent_start",
    { prompt: "A observes open topic", systemPrompt: "system" },
    ctxA,
  ));
  const opened = entriesA.find(entry => (
    entry.customType === "pi-harness-board-checkpoint"
      || entry.customType === "pi-harness-board-delta"
  ));
  assert.match(opened?.content ?? "", /SESSION-A-OPEN-NOTE/);

  board.closeTopic(topic);
  await fire("session_start", {}, ctxB);
  const closed = await fire(
    "before_agent_start",
    { prompt: "A observes close after B starts", systemPrompt: "system" },
    ctxA,
  );
  const tombstone = messageOf(closed, "pi-harness-board-delta");
  assert.ok(tombstone);
  assert.match(tombstone.content, /topic_closed/);
  assert.match(tombstone.content, new RegExp(topic));

  await fire("session_shutdown", {}, ctxA);
  await fire("session_shutdown", {}, ctxB);
  await fire("session_start", { reason: "resume" }, runtimeContext(1_000_000));
});

test("closed candidate 的 archive 缺失或 incarnation 不匹配时保留 open cursor 并等待重试", () => {
  const missing = buildBoardDelivery(new Set(["missing-close-archive"]), {
    hasCheckpoint: true,
    topicSeqs: { "missing-close-archive": 3 },
    topicStates: { "missing-close-archive": "open" },
    topicIncarnations: { "missing-close-archive": 123 },
  });
  assert.equal(missing.mode, "none");
  assert.deepEqual(missing.topicStates, {});
  assert.ok(missing.warnings?.[0].includes("archive unavailable or invalid"));

  const archived = board.listTopics().find(item => item.id === "cross-agent-topic" && item.status === "closed");
  assert.ok(archived);
  const mismatched = buildBoardDelivery(new Set(["cross-agent-topic"]), {
    hasCheckpoint: true,
    topicSeqs: { "cross-agent-topic": 1 },
    topicStates: { "cross-agent-topic": "open" },
    topicIncarnations: { "cross-agent-topic": archived.createdAt + 1 },
  });
  assert.equal(mismatched.mode, "none");
  assert.deepEqual(mismatched.topicStates, {});
  assert.deepEqual(mismatched.warnings, [
    "closed topic cross-agent-topic archive incarnation mismatch; prior open cursor retained",
  ]);
});

test("__proto__ topic ID 在 checkpoint/coverage/delta 中作为 own cursor key 稳定往返", () => {
  const topic = "__proto__";
  board.openTopic(topic, "reserved object key must remain a Board identity");
  board.postNote(topic, "agent", "PROTO-FIRST-NOTE");
  const checkpoint = buildBoardDelivery(new Set([topic]), {
    hasCheckpoint: false,
    topicSeqs: {},
    topicStates: {},
    topicIncarnations: {},
  });
  assert.equal(checkpoint.mode, "checkpoint");
  assert.equal(Object.hasOwn(checkpoint.topicSeqs, topic), true);
  assert.equal(checkpoint.topicSeqs[topic], 1);

  const coverage = deriveBoardCoverage([JSON.parse(JSON.stringify(checkpoint))]);
  assert.equal(Object.hasOwn(coverage.topicStates, topic), true);
  assert.equal(coverage.topicStates[topic], "open");
  board.postNote(topic, "agent", "PROTO-SECOND-NOTE");
  const delta = buildBoardDelivery(new Set([topic]), coverage);
  assert.equal(delta.mode, "delta");
  assert.match(delta.content, /PROTO-SECOND-NOTE/);
  assert.doesNotMatch(delta.content, /PROTO-FIRST-NOTE/);
  assert.equal(Object.hasOwn(delta.topicIncarnations, topic), true);
  assert.equal(delta.topicSeqs[topic], 2);
  const stableCoverage = deriveBoardCoverage([
    JSON.parse(JSON.stringify(checkpoint)),
    JSON.parse(JSON.stringify(delta)),
  ]);
  assert.equal(buildBoardDelivery(new Set([topic]), stableCoverage).mode, "none");
  board.closeTopic(topic);
});

test("Board listing 失败时延后同步，不把仍开放 topic 误判为关闭", async () => {
  const topics = join(projectDir, ".pi-board", "topics");
  const unavailable = join(projectDir, ".pi-board", "topics-unavailable");
  const errors: string[] = [];
  const originalError = console.error;
  renameSync(topics, unavailable);
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    const results = await startTurn("listing unavailable");
    assert.equal(messageOf(results, "pi-harness-board-checkpoint"), undefined);
    assert.equal(messageOf(results, "pi-harness-board-delta"), undefined);
    assert.ok(errors.some(line => line.includes("Board delivery notice")));
  } finally {
    console.error = originalError;
    renameSync(unavailable, topics);
  }
});

test("catalog 初始化失败后，修复后 explicit join 不会丢失新 topic", async () => {
  const preservedEntries = contextEntries;
  const joined = "init-retry-joined";
  const broken = "init-retry-broken";
  board.openTopic(joined, "explicit join after catalog retry");
  board.openTopic(broken, "temporarily malformed startup fixture");
  const brokenPath = join(projectDir, ".pi-board", "topics", `${broken}.jsonl`);
  const originalBroken = readFileSync(brokenPath, "utf-8");
  contextEntries = [];

  try {
    writeFileSync(brokenPath, "invalid-meta\n", "utf-8");
    await fire("session_start", { reason: "resume" }, runtimeContext(1_000_000));
    writeFileSync(brokenPath, originalBroken, "utf-8");

    board.postNote(joined, "current-agent", "EXPLICIT-JOIN-MUST-APPEAR");
    await participate(joined, "join", "after catalog recovery");
    const results = await startTurn("retry catalog initialization");
    const checkpoint = messageOf(results, "pi-harness-board-checkpoint");
    assert.ok(checkpoint);
    assert.match(checkpoint.content, /EXPLICIT-JOIN-MUST-APPEAR/);
  } finally {
    writeFileSync(brokenPath, originalBroken, "utf-8");
    for (const topic of [joined, broken]) {
      if (board.listOpenTopics().some(open => open.id === topic)) board.closeTopic(topic);
    }
    contextEntries = preservedEntries;
    await fire("session_start", { reason: "resume" }, runtimeContext(1_000_000));
  }
});
