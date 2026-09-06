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
let sentUserMessages: Array<{ content: string; options: any }>;
let sentSteers: Array<{ message: any; options: any }>;
let goal: typeof import("../core/goal/index.ts");
let board: typeof import("../core/board/index.ts");

function runtimeContext(sessionId: string, contextWindow = 1_000_000, idle = true): any {
  const activeEntries = contextEntries.get(sessionId) ?? [];
  let idleState = idle;
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      buildContextEntries: () => activeEntries,
      getBranch: () => activeEntries,
    },
    model: { id: "test-model", contextWindow },
    getContextUsage: () => ({ tokens: 0, contextWindow, percent: 0 }),
    isIdle: () => idleState,
    async waitForIdle() {
      idleState = true;
    },
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
  sentUserMessages = [];
  sentSteers = [];

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
    sendUserMessage(content: string, options?: any) {
      sentUserMessages.push({ content, options });
    },
    sendMessage(message: any, options?: any) {
      sentSteers.push({ message, options });
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
  sentUserMessages.length = 0;
  sentSteers.length = 0;
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

test("/goal <objective> persists the visible command and starts execution immediately", async () => {
  const sessionId = "extension-immediate-start";
  await goalCommand.handler("execute this objective", runtimeContext(sessionId));

  assert.equal(goal.getGoal(sessionId)?.text, "execute this objective");
  assert.deepEqual(sentUserMessages, [{ content: "/goal execute this objective", options: undefined }]);

  // The echoed command turn is goal setup, not goal work: its first
  // before_agent_start must not advance the turn counter.
  const echoResults = await startTurn(sessionId, "/goal execute this objective");
  assert.equal(goalMessage(echoResults), undefined, "echo turn must not inject a goal message");
  assert.equal(goal.getGoal(sessionId)?.userTurnCount, 0, "echo turn must not count as goal work");

  const realResults = await startTurn(sessionId, "real work");
  assert.ok(goalMessage(realResults));
  assert.equal(goal.getGoal(sessionId)?.userTurnCount, 1);
});

test("/goal echo is bounded while the stored objective remains exact", async () => {
  const sessionId = "extension-fat-echo";
  const objective = `BEGIN-${"A".repeat(5_000)}-END`;
  await goalCommand.handler(objective, runtimeContext(sessionId));
  assert.equal(goal.getGoal(sessionId)?.text, objective);
  assert.equal(sentUserMessages.length, 1);
  assert.ok(Buffer.byteLength(sentUserMessages[0].content, "utf-8") < 1_300);
  assert.match(sentUserMessages[0].content, /\[excerpt 1024\/\d+ bytes sha256=/);
  assert.match(sentUserMessages[0].content, /full objective remains available via \/goal status/);
  assert.doesNotMatch(sentUserMessages[0].content, /-END/);
});

test("/goal waits for an active run to settle before starting the replacement objective", async () => {
  const sessionId = "extension-deferred-start";
  const ctx = runtimeContext(sessionId, 1_000_000, false);
  await goalCommand.handler("replacement objective", ctx);

  assert.deepEqual(sentUserMessages, [{ content: "/goal replacement objective", options: undefined }]);
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
  await assert.rejects(
    boardTool.execute("failed", input, undefined, undefined, ctx),
    /topic is required/,
  );
  // AgentSession converts a rejected execute() into the standard failed
  // tool_result event consumed by extensions.
  await fire("tool_result", {
    toolName: "board",
    toolCallId: "failed",
    input,
    content: [{ type: "text", text: "topic is required for post" }],
    isError: true,
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
    isError: wrongResult.isError ?? false,
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
    isError: result.isError ?? false,
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
  assert.equal(sentUserMessages.length, 1, "only /goal <objective> starts an agent turn");
  assert.equal((handlers.context ?? []).length, 1, "context hook is legacy-status cleanup only");
});

test("active goal queues an auto-continuation steer when a reporting turn ends", async () => {
  const sessionId = "extension-auto-continue";
  const ctx = runtimeContext(sessionId);
  await goalCommand.handler("keep working until done", ctx);
  const state = goal.getGoal(sessionId)!;

  await fire("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", content: [], stopReason: "stop" }],
  }, ctx);

  assert.equal(sentSteers.length, 1);
  assert.equal(sentSteers[0].options.deliverAs, "steer");
  assert.equal(sentSteers[0].message.customType, "pi-harness-goal-continue");
  assert.equal(sentSteers[0].message.details.autoContinue, 1);
  assert.equal(sentSteers[0].message.details.limit, 4);
  assert.match(sentSteers[0].message.content, /keep working until done/);
  assert.match(sentSteers[0].message.content, /automatic continuation/);
  assert.match(sentSteers[0].message.content, new RegExp(goal.goalEvidenceTag(state.id)));
});

test("auto-continuation respects the per-user-turn cap and resets on the next real turn", async () => {
  const sessionId = "extension-auto-continue-cap";
  const ctx = runtimeContext(sessionId);
  await goalCommand.handler("bounded objective", ctx);
  const endEvent = {
    type: "agent_end",
    messages: [{ role: "assistant", content: [], stopReason: "stop" }],
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await fire("agent_end", endEvent, ctx);
  }
  assert.equal(sentSteers.length, 4, "cap of 4 must bound the loop");

  // A real user turn resets the budget; continuation flows again.
  await startTurn(sessionId, "next user turn");
  await fire("agent_end", endEvent, ctx);
  assert.equal(sentSteers.length, 5);
  assert.equal(sentSteers.at(-1)!.message.details.autoContinue, 1);
});

test("auto-continuation never fires for absent, paused, or achieved goals or aborted turns", async () => {
  const sessionId = "extension-auto-continue-gates";
  const ctx = runtimeContext(sessionId);
  const endEvent = (stopReason: string) => ({
    type: "agent_end",
    messages: [{ role: "assistant", content: [], stopReason }],
  });

  // No goal at all.
  await fire("agent_end", endEvent("stop"), ctx);
  assert.equal(sentSteers.length, 0);

  // Paused goal.
  await goalCommand.handler("pause-me", ctx);
  await goalCommand.handler("pause", ctx);
  await fire("agent_end", endEvent("stop"), ctx);
  assert.equal(sentSteers.length, 0);

  // Aborted/error turns never continue.
  await goalCommand.handler("resume-me", ctx);
  await goalCommand.handler("resume", ctx);
  await fire("agent_end", endEvent("aborted"), ctx);
  await fire("agent_end", endEvent("error"), ctx);
  assert.equal(sentSteers.length, 0);

  // Achieved goal stops continuation.
  await fire("agent_end", endEvent("stop"), ctx);
  assert.equal(sentSteers.length, 1, "active goal continues once");
  const state = goal.getGoal(sessionId)!;
  board.openTopic("extension-auto-continue-achieved", "achieve");
  const input = {
    action: "post",
    topic: "extension-auto-continue-achieved",
    content: "done",
    tags: [goal.GOAL_MET_TAG, goal.goalEvidenceTag(state.id)],
  };
  const result = await boardTool.execute("done", input, undefined, undefined, ctx);
  await fire("tool_result", {
    toolName: "board",
    toolCallId: "done",
    input,
    content: result.content,
    details: result.details,
    isError: result.isError ?? false,
  }, ctx);
  assert.equal(goal.getGoal(sessionId)?.status, "achieved");
  await fire("agent_end", endEvent("stop"), ctx);
  assert.equal(sentSteers.length, 1, "achieved goal must not auto-continue");
});
