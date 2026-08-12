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
let goal: typeof import("../core/goal/index.ts");
let board: typeof import("../core/board/index.ts");

function runtimeContext(sessionId: string, contextWindow = 1_000_000): any {
  return {
    sessionManager: { getSessionId: () => sessionId },
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
  return result.messages.find((message: any) => message.customType === "pi-harness-goal");
}

before(async () => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-goal-extension-test-"));
  process.chdir(workDir);
  handlers = {};
  entries = [];
  notifications = [];

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

test("before_agent_start freezes one auditable goal message for every LLM call in a user turn", async () => {
  const sessionId = "extension-freeze";
  const ctx = runtimeContext(sessionId);
  await goalCommand.handler("finish frozen context", ctx);
  await fire("before_agent_start", { prompt: "work" }, ctx);

  const base = { messages: [{ role: "user", content: "work", timestamp: 1 }] };
  const first = (await fire("context", structuredClone(base), ctx))[0];
  const second = (await fire("context", structuredClone(base), ctx))[0];
  assert.deepEqual(goalMessage(second), goalMessage(first));
  assert.equal(goal.getGoal(sessionId)?.userTurnCount, 1);

  const snapshot = entries.find(entry => entry.type === "pi-harness-goal-snapshot")!;
  assert.ok(snapshot);
  assert.equal(readFileSync(snapshot.data.path, "utf-8"), goalMessage(first).content);

  await fire("before_agent_start", { prompt: "next" }, ctx);
  const third = (await fire("context", { messages: [{ role: "user", content: "next" }] }, ctx))[0];
  assert.equal(goal.getGoal(sessionId)?.userTurnCount, 2);
  assert.notEqual(goalMessage(third).content, goalMessage(first).content);
});

test("a parent session frozen goal never leaks into a child session context", async () => {
  const parentCtx = runtimeContext("extension-parent");
  const childCtx = runtimeContext("extension-child");
  await goalCommand.handler("parent-only objective", parentCtx);
  await fire("before_agent_start", { prompt: "parent work" }, parentCtx);
  const parentResult = (await fire(
    "context",
    { messages: [{ role: "user", content: "parent work" }] },
    parentCtx,
  ))[0];
  const leakedMessage = goalMessage(parentResult);
  assert.ok(leakedMessage);

  await fire("before_agent_start", { prompt: "child work" }, childCtx);
  const childResult = (await fire(
    "context",
    { messages: [leakedMessage, { role: "user", content: "child work" }] },
    childCtx,
  ))[0];
  assert.equal(goal.getGoal("extension-child"), null);
  assert.equal(childResult.messages.length, 1);
  assert.equal(childResult.messages[0].role, "user");
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
  assert.equal((handlers.context ?? []).length, 1);
});
