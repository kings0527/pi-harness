import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { boundedEscapedXmlText, boundedExcerpt, boundedIntEnv, escapedXmlByteLength } from "../core/text-budget/index.ts";
import { inlineNoteBody } from "../core/board/digest.ts";
import { buildBoardDelivery, formatCriticalMessage } from "../core/context-reference/index.ts";

const ENV_KEYS = [
  "PI_BOARD_GOAL_EXCERPT_BYTES",
  "PI_BOARD_CATALOG_MAX_LIST",
  "PI_BOARD_CATALOG_MAX_BYTES",
  "PI_BOARD_INLINE_NOTE_MAX_BYTES",
  "PI_BOARD_AUTHOR_EXCERPT_BYTES",
  "PI_BOARD_REFERENCE_MAX_BYTES",
  "PI_BOARD_CRITICAL_MAX_BYTES",
  "PI_BOARD_CRITICAL_SOURCE_MAX_LIST",
  "PI_BOARD_TOPIC_EXCERPT_BYTES",
  "PI_BOARD_CATALOG_ITEM_EXCERPT_BYTES",
] as const;

let originalCwd: string;
let savedEnv: Record<string, string | undefined>;
let sandbox: string;
let handlers: Record<string, Array<(...args: any[]) => any>>;
let sessionEntries: Array<{ type: string; data: any }>;
let contextEntries: any[];
let board: typeof import("../core/board/index.ts");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

before(async () => {
  originalCwd = process.cwd();
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-feed-budget-test-")));
  process.chdir(sandbox);

  board = await import("../core/board/index.ts");
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
  await fire("session_start", {}, runtimeContext());
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

after(() => {
  process.chdir(originalCwd);
  rmSync(sandbox, { recursive: true, force: true });
});

function runtimeContext(): any {
  return {
    sessionManager: {
      getSessionId: () => "feed-budget-session",
      buildContextEntries: () => contextEntries,
      getBranch: () => contextEntries,
    },
    model: { id: "test-model", contextWindow: 1_000_000 },
    getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000, percent: 0 }),
  };
}

async function fire(name: string, event: any, ctx: any): Promise<any[]> {
  const results = [];
  for (const handler of handlers[name] ?? []) results.push(await handler(event, ctx));
  return results;
}

async function startTurn(prompt = "question"): Promise<any[]> {
  const results = await fire("before_agent_start", { prompt, systemPrompt: "system" }, runtimeContext());
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

async function joinTopic(topic: string): Promise<void> {
  await fire("tool_result", {
    tool: "board",
    input: { action: "post", topic },
    result: { ok: true },
  }, runtimeContext());
}

test("boundedExcerpt 原样放行短文本，显式标记长文本且 code point 安全", () => {
  assert.equal(boundedExcerpt("short goal", 240), "short goal");

  const fat = `前缀-${"界".repeat(500)}`;
  const excerpt = boundedExcerpt(fat, 64);
  assert.match(excerpt, /…\[excerpt \d+\/\d+ bytes sha256=[a-f0-9]{64}\]$/);
  assert.ok(!excerpt.includes(String.fromCharCode(0xFFFD)), "cut must never split a code point");
  const kept = excerpt.slice(0, excerpt.indexOf("…[excerpt"));
  assert.ok(Buffer.byteLength(kept, "utf-8") <= 64);
  assert.ok(excerpt.includes(sha256(fat)), "marker carries the sha256 of the complete text");

  assert.throws(() => boundedExcerpt("x", 0), /positive integer/);
});

test("boundedEscapedXmlText 按实际 XML 字节上限截断", () => {
  const fat = "&".repeat(200);
  const rendered = boundedEscapedXmlText(fat, 160, "board action=read");
  assert.ok(Buffer.byteLength(rendered, "utf-8") <= 160);
  assert.equal(escapedXmlByteLength(fat), 1000);
  assert.match(rendered, /sha256=[a-f0-9]{64}/);
  assert.match(rendered, /retrieve via board action=read/);
});

test("boundedIntEnv 未设置走默认，非法值 fail-loud", () => {
  delete process.env.PI_BOARD_TEST_CAP;
  assert.equal(boundedIntEnv("PI_BOARD_TEST_CAP", 42), 42);
  process.env.PI_BOARD_TEST_CAP = "7";
  assert.equal(boundedIntEnv("PI_BOARD_TEST_CAP", 42), 7);
  process.env.PI_BOARD_TEST_CAP = "0";
  assert.throws(() => boundedIntEnv("PI_BOARD_TEST_CAP", 42), /positive integer/);
  process.env.PI_BOARD_TEST_CAP = "abc";
  assert.throws(() => boundedIntEnv("PI_BOARD_TEST_CAP", 42), /positive integer/);
  delete process.env.PI_BOARD_TEST_CAP;
});

test("inlineNoteBody 小正文原样、大正文显式 stub 且确定", () => {
  assert.equal(inlineNoteBody("small finding"), "small finding");
  process.env.PI_BOARD_INLINE_NOTE_MAX_BYTES = "64";
  const fat = "B".repeat(500);
  const stub = inlineNoteBody(fat);
  assert.match(stub, /^\[note body withheld from feed: 500 bytes, sha256=[a-f0-9]{64};/);
  assert.ok(stub.includes(sha256(fat)));
  assert.ok(stub.includes("board action=read"));
  assert.ok(!stub.includes(fat));
  assert.equal(inlineNoteBody(fat), stub, "stub is deterministic for content-addressed dedup");
});

test("catalog 对 fat goal 只携带显式摘录，不携带原文", async () => {
  process.env.PI_BOARD_GOAL_EXCERPT_BYTES = "64";
  const fatGoal = `FAT-GOAL-START-${"A".repeat(5000)}-FAT-GOAL-END`;
  board.openTopic("fat-goal-topic", fatGoal);

  const catalog = messageOf(await startTurn(), "pi-harness-board-catalog");
  assert.ok(catalog);
  assert.match(catalog.content, /fat-goal-topic/);
  assert.match(catalog.content, /\[excerpt 64\/\d+ bytes sha256=/);
  assert.ok(!catalog.content.includes(fatGoal), "catalog must never carry the complete fat goal");
});

test("catalog participants/relations 超出名单帽时显式计数", async () => {
  process.env.PI_BOARD_CATALOG_MAX_LIST = "3";
  board.openTopic("fat-list-topic", "list cap fixture");
  for (let i = 0; i < 5; i += 1) {
    board.postNote("fat-list-topic", `agent-${i}`, `note ${i}`, { actor: { id: `session-${i}` } });
  }
  const results = await startTurn();
  const catalog = messageOf(results, "pi-harness-board-catalog");
  assert.ok(catalog);
  assert.equal(catalog.details.mode, "delta", "an existing catalog receives only changed rows");
  assert.match(catalog.content, /participants=session-0,session-1,session-2 participants_total=5/);
  assert.ok(!catalog.content.includes("session-4"), "overflow entries stay out of the catalog row");
});

test("catalog 字节帽 fail-loud：不投递部分 catalog，Board 交付降级为告警", async () => {
  process.env.PI_BOARD_CATALOG_MAX_BYTES = "100";
  const results = await startTurn();
  assert.equal(messageOf(results, "pi-harness-board-catalog"), undefined, "over-budget catalog is deferred, not truncated");
  assert.equal(messageOf(results, "pi-harness-board-checkpoint"), undefined);
  assert.equal(messageOf(results, "pi-harness-board-delta"), undefined);
});

test("joined topic 的 fat note 在 checkpoint 中是显式 stub，goal 头是摘录", async () => {
  process.env.PI_BOARD_GOAL_EXCERPT_BYTES = "64";
  process.env.PI_BOARD_INLINE_NOTE_MAX_BYTES = "128";
  const fatGoal = `CHECKPOINT-GOAL-${"G".repeat(3000)}`;
  const fatBody = `FAT-NOTE-START-${"N".repeat(4000)}-FAT-NOTE-END`;
  board.openTopic("fat-joined", fatGoal);
  board.postNote("fat-joined", "worker", fatBody);
  await joinTopic("fat-joined");

  const results = await startTurn();
  const delivery = messageOf(results, "pi-harness-board-checkpoint")
    ?? messageOf(results, "pi-harness-board-delta");
  assert.ok(delivery, "joined topic must deliver its notes");
  assert.match(delivery.content, /Board fat-joined \(/);
  assert.match(delivery.content, /\[excerpt 64\/\d+ bytes sha256=/);
  assert.match(delivery.content, /\[note body withheld from feed: \d+ bytes, sha256=/);
  assert.ok(delivery.content.includes(sha256(fatBody)));
  assert.ok(!delivery.content.includes("FAT-NOTE-END"), "complete fat body must not enter the feed");
  assert.ok(!delivery.content.includes(fatGoal), "complete fat goal must not enter the feed");
});

test("CRITICAL fat note 走同一内联护栏，goal 属性同为摘录", async () => {
  process.env.PI_BOARD_GOAL_EXCERPT_BYTES = "64";
  process.env.PI_BOARD_INLINE_NOTE_MAX_BYTES = "128";
  const fatGoal = `CRITICAL-GOAL-${"C".repeat(3000)}`;
  const fatBody = `CRITICAL-BODY-${"X".repeat(4000)}`;
  board.openTopic("fat-critical", fatGoal);
  board.postNote("fat-critical", "worker", fatBody, { priority: "critical" });
  await joinTopic("fat-critical");

  const critical = messageOf(await startTurn(), "pi-harness-board-critical");
  assert.ok(critical);
  assert.equal(critical.display, true);
  assert.match(critical.content, /\[note body withheld from feed: \d+ bytes, sha256=/);
  assert.ok(critical.content.includes(sha256(fatBody)));
  assert.ok(!critical.content.includes(fatBody));
  assert.ok(!critical.content.includes(fatGoal));
  assert.match(critical.content, /\[excerpt 64\/\d+ bytes sha256=/);
});

test("checkpoint/delta、CRITICAL、author 都按最终渲染总字节受限", () => {
  process.env.PI_BOARD_REFERENCE_MAX_BYTES = "2048";
  process.env.PI_BOARD_CRITICAL_MAX_BYTES = "2048";
  process.env.PI_BOARD_AUTHOR_EXCERPT_BYTES = "64";
  process.env.PI_BOARD_TOPIC_EXCERPT_BYTES = "64";

  board.openTopic("aggregate-normal", "small");
  for (let i = 0; i < 16; i += 1) {
    board.postNote("aggregate-normal", "A".repeat(5_000), "&".repeat(32_768));
  }
  const normal = buildBoardDelivery(new Set(["aggregate-normal"]), {
    hasCheckpoint: false, topicSeqs: {}, topicStates: {}, topicIncarnations: {},
  });
  assert.ok(Buffer.byteLength(normal.content, "utf-8") <= 2048);
  assert.match(normal.content, /automatic Board board_checkpoint withheld from feed/);
  assert.match(normal.content, /retrieve via board action=read/);

  board.openTopic("aggregate-critical", "small");
  for (let i = 0; i < 16; i += 1) {
    board.postNote("aggregate-critical", "A".repeat(5_000), "&".repeat(32_768), { priority: "critical" });
  }
  const criticalDelivery = buildBoardDelivery(new Set(["aggregate-critical"]), {
    hasCheckpoint: false, topicSeqs: {}, topicStates: {}, topicIncarnations: {},
  });
  const critical = formatCriticalMessage(criticalDelivery.criticalUpdates);
  assert.ok(Buffer.byteLength(critical, "utf-8") <= 2048);
  assert.match(critical, /automatic Board CRITICAL updates withheld from feed/);
  assert.match(critical, /retrieve each source via board action=read/);
});
