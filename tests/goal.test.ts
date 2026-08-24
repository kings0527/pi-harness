import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let originalCwd: string;
let goal: typeof import("../core/goal/index.ts");
let board: typeof import("../core/board/index.ts");

before(async () => {
  originalCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-goal-test-")));
  process.chdir(workDir);
  goal = await import("../core/goal/index.ts");
  board = await import("../core/board/index.ts");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

test("goal state is isolated by pi session id", () => {
  const first = goal.setGoal("session-a", "complete A");
  const second = goal.setGoal("session-b", "complete B");

  assert.notEqual(first.id, second.id);
  assert.equal(goal.getGoal("session-a")?.text, "complete A");
  assert.equal(goal.getGoal("session-b")?.text, "complete B");
  assert.equal(first.sessionId, "session-a");
  assert.equal(first.userTurnCount, 0);
  assert.ok(existsSync(goal.getGoalFilePath("session-a")));
  assert.ok(existsSync(goal.getGoalFilePath("session-b")));
});

test("session ids cannot escape .pi-board/goals or collide after sanitization", () => {
  goal.setGoal("../../session", "traversal-safe");
  goal.setGoal(".._.._session", "collision-safe");

  const traversalPath = goal.getGoalFilePath("../../session");
  const collisionPath = goal.getGoalFilePath(".._.._session");
  const goalsRoot = join(workDir, ".pi-board", "goals");
  assert.ok(traversalPath.startsWith(goalsRoot + "/"));
  assert.ok(collisionPath.startsWith(goalsRoot + "/"));
  assert.notEqual(traversalPath, collisionPath);
  assert.equal(goal.getGoal("../../session")?.text, "traversal-safe");
  assert.equal(goal.getGoal(".._.._session")?.text, "collision-safe");
});

test("domain transitions preserve state and count user turns only", () => {
  const created = goal.setGoal("session-transitions", "state transitions");
  assert.equal(goal.pauseGoal("session-transitions")?.status, "paused");
  assert.equal(goal.beginGoalTurn("session-transitions", created.id), null, "paused goals do not advance");
  assert.equal(goal.resumeGoal("session-transitions")?.status, "active");

  const advanced = goal.beginGoalTurn("session-transitions", created.id);
  assert.equal(advanced?.userTurnCount, 1);
  assert.equal(goal.beginGoalTurn("session-transitions", "wrong-goal-id"), null);
  assert.equal(goal.getGoal("session-transitions")?.userTurnCount, 1);
});

test("completion requires the exact persisted Board note and current goal id", () => {
  const state = goal.setGoal("session-complete", "verified completion");
  board.openTopic("goal-completion", "Collect completion evidence");

  const unbound = board.postNote("goal-completion", "agent", "Evidence without goal binding", {
    tags: [goal.GOAL_MET_TAG],
  });
  assert.equal(
    goal.completeGoalFromBoardNote("session-complete", state.id, "goal-completion", unbound.seq),
    null,
  );
  assert.equal(goal.getGoal("session-complete")?.status, "active");

  const bound = board.postNote("goal-completion", "agent", "Tests and output verify completion", {
    tags: [goal.GOAL_MET_TAG, goal.goalEvidenceTag(state.id)],
  });
  const completed = goal.completeGoalFromBoardNote(
    "session-complete",
    state.id,
    "goal-completion",
    bound.seq,
  );
  assert.equal(completed?.status, "achieved");
  assert.equal(completed?.evidence?.topic, "goal-completion");
  assert.equal(completed?.evidence?.noteSeq, bound.seq);
});

test("goal reference snapshots are content-addressed and preserve exact bytes", () => {
  const created = goal.setGoal("session-snapshot", "verify <goal> & evidence");
  const firstTurn = goal.beginGoalTurn("session-snapshot", created.id)!;
  const first = goal.createGoalReferenceSnapshot(firstTurn);
  const secondTurn = goal.beginGoalTurn("session-snapshot", created.id)!;
  const second = goal.createGoalReferenceSnapshot(secondTurn);

  assert.equal(first.id, second.id);
  assert.equal(first.content, second.content);
  assert.equal(readFileSync(first.path, "utf-8"), first.content);
  assert.doesNotMatch(first.content, /user_turn=/);
  assert.match(first.content, /verify &lt;goal&gt; &amp; evidence/);
  assert.match(first.content, new RegExp(goal.goalEvidenceTag(firstTurn.id)));
  assert.equal(second.userTurnCount, 2, "turn accounting stays in metadata, outside prompt bytes");
});

test("active goal makes route selection autonomous unless every path is truly blocked", () => {
  const state = goal.setGoal("session-autonomous", "finish without delegating routine choices");
  const reference = goal.renderGoalReference(state);

  assert.match(reference, /choose the best evidence-backed, reversible route and execute it/i);
  assert.match(reference, /do not stop to ask the user to pick/i);
  assert.match(reference, /only when every meaningful route is blocked/i);
  assert.match(reference, /otherwise state assumptions and keep working/i);
});

test("clearGoal removes only the selected session goal", () => {
  goal.setGoal("session-clear-a", "clear me");
  goal.setGoal("session-clear-b", "keep me");
  const cleared = goal.clearGoal("session-clear-a");

  assert.equal(cleared?.text, "clear me");
  assert.equal(goal.getGoal("session-clear-a"), null);
  assert.equal(goal.getGoal("session-clear-b")?.text, "keep me");
});

test("goal core remains runtime-agnostic", () => {
  const sourcePath = join(originalCwd, "core", "goal", "index.ts");
  const source = readFileSync(sourcePath, "utf-8");
  assert.ok(!source.includes("@earendil"), "core/goal must not import pi packages");
});

test("auto-continuation policy gates on status, stop reason, and per-turn cap", () => {
  const active = goal.setGoal("session-auto-policy", "continue policy");
  assert.equal(goal.shouldAutoContinueGoal(active, "stop", 0), true);
  assert.equal(goal.shouldAutoContinueGoal(active, undefined, 0), true);
  assert.equal(goal.shouldAutoContinueGoal(active, "toolUse", 3), true);

  assert.equal(goal.shouldAutoContinueGoal(active, "error", 0), false);
  assert.equal(goal.shouldAutoContinueGoal(active, "aborted", 0), false);
  assert.equal(goal.shouldAutoContinueGoal(active, "stop", 4), false, "cap is exclusive");
  assert.equal(goal.shouldAutoContinueGoal(active, "stop", 5), false);
  assert.equal(goal.shouldAutoContinueGoal(null, "stop", 0), false);

  const paused = goal.pauseGoal("session-auto-policy");
  assert.equal(goal.shouldAutoContinueGoal(paused, "stop", 0), false);
  const resumed = goal.resumeGoal("session-auto-policy");
  assert.equal(goal.shouldAutoContinueGoal(resumed, "stop", 0), true);
});

test("goal continue message re-asserts objective, tags, and blocker policy", () => {
  const state = goal.setGoal("session-auto-message", "finish the offline pipeline");
  const rendered = goal.renderGoalContinueMessage(state, 2, 4);

  assert.match(rendered, /<goal_continue/);
  assert.match(rendered, /attempt="2"/);
  assert.match(rendered, /limit="4"/);
  assert.match(rendered, /finish the offline pipeline/);
  assert.match(rendered, /automatic continuation/);
  assert.match(rendered, /goal-met/);
  assert.match(rendered, new RegExp(goal.goalEvidenceTag(state.id)));
  assert.match(rendered, /blocked by missing information/);
});
