import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalCwd: string;
let workDir: string;
let handlers: Record<string, Array<(event: any, ctx: any) => any>>;
let goalCommand: any;
let boardTool: any;
let entries: Array<{ type: string; data: any }>;
let notifications: Array<{ sessionId: string; message: string; level: string }>;
let contextEntries: Map<string, any[]>;
let goal: typeof import("../core/goal/index.ts");
let board: typeof import("../core/board/index.ts");

function runtimeContext(sessionId: string, contextWindow = 1_000_000): any {
  const activeEntries = contextEntries.get(sessionId) ?? [];
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      buildContextEntries: () => activeEntries,
      getBranch: () => activeEntries,
    },
    model: { id: "test-model", contextWindow },
    getContextUsage: () => ({ tokens: 0, contextWindow, percent: 0 }),
    ui: {
      notify(message: string, level: string) {
        notifications.push({ sessionId, message, level });
      },
    },
  };
}

async function fire(name: string, event: any, ctx: any): Promise<any[]> {
  const results = [];
  for (const handler of handlers[name] ?? []) results.push(await handler(event, ctx));
  return results;
}

function goalMessage(result: any): any {
  return result
    .flatMap((item: any) => item?.message ? [item.message] : [])
    .find((message: any) => message.customType === "pi-harness-goal");
}

async function startTurn(sessionId: string, prompt: string): Promise<any[]> {
  const ctx = runtimeContext(sessionId);
  const results = await fire("before_agent_start", { prompt }, ctx);
  const activeEntries = contextEntries.get(sessionId) ?? [];
  activeEntries.push({
    type: "message",
    message: { role: "user", content: prompt, timestamp: Date.now() },
  });
  for (const result of results) {
    if (!result?.message) continue;
    activeEntries.push({
      type: "custom_message",
      ...result.message,
      timestamp: new Date().toISOString(),
    });
  }
  contextEntries.set(sessionId, activeEntries);
  return results;
}

before(async () => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-goal-extension-test-"));
  process.chdir(workDir);
  handlers = {};
  entries = [];
  notifications = [];
  contextEntries = new Map();

  const fakePi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      (handlers[name] ??= []).push(handler);
    },
    registerCommand(name: string, command: any) {
      if (name === "goal") goalCommand = command;
    },
    registerTool(tool: any) {
      if (tool.name === "board") boardTool = tool;
    },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
  };

  const goalExtension = (await import(`../extensions/goal.ts?test=${Date.now()}`)).default;
  const boardExtension = (await import(`../extensions/board.ts?goal-test=${Date.now()}`)).default;
  await goalExtension(fakePi as any);
  await boardExtension(fakePi as any);
  goal = await import("../core/goal/index.ts");
  board = await import("../core/board/index.ts");
});

beforeEach(() => {
  entries.length = 0;
  notifications.length = 0;
});

after(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

test("slash command stores independent goals for independent pi sessions", async () => {
  await goalCommand.handler("goal A", runtimeContext("extension-session-a"));
  await goalCommand.handler("goal B", runtimeContext("extension-session-b"));

  assert.equal(goal.getGoal("extension-session-a")?.text, "goal A");
  assert.equal(goal.getGoal("extension-session-b")?.text, "goal B");
  assert.equal(notifications.length, 2);
});

test("active goal is appended once and leaves the next user turn cache-prefix append-only", async () => {
  const sessionId = "extension-freeze";
  const ctx = runtimeContext(sessionId);
  await goalCommand.handler("finish frozen context", ctx);
  const firstResults = await startTurn(sessionId, "work");
  const first = goalMessage(firstResults);
  assert.ok(first);
  assert.equal(first.details.status, "active");
  assert.equal(goal.getGoal(sessionId)?.userTurnCount, 1);

  const firstSnapshot = entries.find(entry => entry.type === "pi-harness-goal-snapshot")!;
  assert.ok(firstSnapshot);
  assert.equal(readFileSync(firstSnapshot.data.path, "utf-8"), first.content);

  const cachedPrefix = structuredClone(contextEntries.get(sessionId)!);
  const secondResults = await startTurn(sessionId, "next");
  assert.equal(goalMessage(secondResults), undefined, "unchanged active goal must not be injected again");
  assert.deepEqual(contextEntries.get(sessionId)!.slice(0, cachedPrefix.length), cachedPrefix);
  assert.equal(goal.getGoal(sessionId)?.userTurnCount, 2);
  const snapshots = entries.filter(entry => entry.type === "pi-harness-goal-snapshot");
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].data.snapshotId, snapshots[0].data.snapshotId);
});

test("a forked parent goal is explicitly deactivated in the child session", async () => {
  const parentCtx = runtimeContext("extension-parent");
  await goalCommand.handler("parent-only objective", parentCtx);
  const parentResults = await startTurn("extension-parent", "parent work");
  assert.equal(goalMessage(parentResults).details.status, "active");

  contextEntries.set("extension-child", structuredClone(contextEntries.get("extension-parent")!));
  const childResults = await startTurn("extension-child", "child work");
  const childMarker = goalMessage(childResults);
  assert.equal(goal.getGoal("extension-child"), null);
  assert.equal(childMarker.details.status, "inactive");
  assert.match(childMarker.content, /not active in this session/i);
});

test("pause, resume, and clear append lifecycle markers without rewriting cached history", async () => {
  const sessionId = "extension-lifecycle";
  await goalCommand.handler("lifecycle objective", runtimeContext(sessionId));
  await startTurn(sessionId, "start");

  let cachedPrefix = structuredClone(contextEntries.get(sessionId)!);
  await goalCommand.handler("pause", runtimeContext(sessionId));
  let results = await startTurn(sessionId, "paused turn");
  assert.equal(goalMessage(results).details.status, "paused");
  assert.deepEqual(contextEntries.get(sessionId)!.slice(0, cachedPrefix.length), cachedPrefix);

  cachedPrefix = structuredClone(contextEntries.get(sessionId)!);
  await goalCommand.handler("resume", runtimeContext(sessionId));
  results = await startTurn(sessionId, "resumed turn");
  assert.equal(goalMessage(results).details.status, "active");
  assert.deepEqual(contextEntries.get(sessionId)!.slice(0, cachedPrefix.length), cachedPrefix);

  cachedPrefix = structuredClone(contextEntries.get(sessionId)!);
  await goalCommand.handler("off", runtimeContext(sessionId));
  results = await startTurn(sessionId, "cleared turn");
  assert.equal(goalMessage(results).details.status, "cleared");
  assert.deepEqual(contextEntries.get(sessionId)!.slice(0, cachedPrefix.length), cachedPrefix);
});

test("failed Board execution never completes a goal", async () => {
  const sessionId = "extension-failed-post";
  const ctx = runtimeContext(sessionId);
  await goalCommand.handler("must have real evidence", ctx);
  const state = goal.getGoal(sessionId)!;
  const input = {
    action: "post",
    content: "claimed evidence",
    tags: [goal.GOAL_MET_TAG, goal.goalEvidenceTag(state.id)],
  };

  assert.equal(handlers.tool_call?.length ?? 0, 0, "goal completion must not run in preflight");
  const result = await boardTool.execute("failed", input, undefined, undefined, ctx);
  assert.match(result.content[0].text, /topic is required/);
  await fire("tool_result", {
    toolName: "board",
    toolCallId: "failed",
    input,
    content: result.content,
    details: result.details,
    isError: false,
  }, ctx);
  assert.equal(goal.getGoal(sessionId)?.status, "active");
});

test("only a persisted Board note bound to the current goal completes it", async () => {
  const sessionId = "extension-success-post";
  const ctx = runtimeContext(sessionId);
  await goalCommand.handler("complete with verified evidence", ctx);
  const state = goal.getGoal(sessionId)!;
  board.openTopic("extension-goal-topic", "Verify extension completion");

  const wrongInput = {
    action: "post",
    topic: "extension-goal-topic",
    content: "Evidence for another goal",
    tags: [goal.GOAL_MET_TAG, goal.goalEvidenceTag("wrong-goal-id")],
  };
  const wrongResult = await boardTool.execute("wrong", wrongInput, undefined, undefined, ctx);
  await fire("tool_result", {
    toolName: "board",
    toolCallId: "wrong",
    input: wrongInput,
    content: wrongResult.content,
    details: wrongResult.details,
    isError: false,
  }, ctx);
  assert.equal(goal.getGoal(sessionId)?.status, "active");

  const input = {
    action: "post",
    topic: "extension-goal-topic",
    content: "All regression tests and architecture checks passed",
    tags: [goal.GOAL_MET_TAG, goal.goalEvidenceTag(state.id)],
  };
  const result = await boardTool.execute("success", input, undefined, undefined, ctx);
  const [hookResult] = await fire("tool_result", {
    toolName: "board",
    toolCallId: "success",
    input,
    content: result.content,
    details: result.details,
    isError: false,
  }, ctx);

  const completed = goal.getGoal(sessionId)!;
  assert.equal(completed.status, "achieved");
  assert.equal(completed.evidence?.topic, "extension-goal-topic");
  assert.match(hookResult.content.at(-1).text, /verified and marked achieved/i);
  assert.match(notifications.at(-1)!.message, /Goal achieved/);
});

test("goal status uses operator UI and does not inject persistent status messages", async () => {
  const sessionId = "extension-status";
  const ctx = runtimeContext(sessionId);
  await goalCommand.handler("status goal", ctx);
  await goalCommand.handler("status", ctx);
  await goalCommand.handler("pause", ctx);
  await goalCommand.handler("resume", ctx);
  await goalCommand.handler("off", ctx);

  assert.equal(goal.getGoal(sessionId), null);
  assert.ok(notifications.some(item => item.message.includes("Goal paused")));
  assert.ok(notifications.some(item => item.message.includes("Goal resumed")));
  assert.equal((handlers.context ?? []).length, 1, "context hook is legacy-status cleanup only");
});
