import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// goal 的存储根锚定 process.cwd()/.pi-board（core/storage 惰性初始化），
// 因此在动态 import 前 chdir 到临时目录即可完全隔离，不污染仓库。
let workDir: string;
let originalCwd: string;
let goal: typeof import("../core/goal/index.ts");

before(async () => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-goal-test-"));
  process.chdir(workDir);
  goal = await import("../core/goal/index.ts");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

test("setGoal / getGoal — 创建并读取", () => {
  const state = goal.setGoal("complete all tests");
  assert.equal(state.text, "complete all tests");
  assert.equal(state.status, "active");
  assert.equal(state.turnCount, 0);
  assert.ok(state.createdAt > 0);

  const read = goal.getGoal();
  assert.ok(read);
  assert.equal(read!.text, "complete all tests");
  assert.equal(read!.status, "active");
});

test("updateGoal — 部分更新保留其余字段", () => {
  goal.setGoal("partial update test");
  const updated = goal.updateGoal({ turnCount: 5 });
  assert.ok(updated);
  assert.equal(updated!.text, "partial update test");
  assert.equal(updated!.turnCount, 5);
  assert.equal(updated!.status, "active");
  assert.ok(updated!.updatedAt >= updated!.createdAt);
});

test("clearGoal — 清除后 getGoal 返回 null", () => {
  goal.setGoal("to be cleared");
  assert.ok(goal.getGoal());
  goal.clearGoal();
  assert.equal(goal.getGoal(), null);
});

test("文件格式 — .pi-board/goal.json 存在且可 JSON.parse", () => {
  goal.setGoal("file format test");
  const filePath = join(workDir, ".pi-board", "goal.json");
  assert.ok(existsSync(filePath));
  const content = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content);
  assert.equal(parsed.text, "file format test");
  assert.equal(parsed.status, "active");
});

test("单一活跃 — setGoal 两次，第二次覆盖第一次", () => {
  goal.setGoal("first goal");
  goal.setGoal("second goal");
  const current = goal.getGoal();
  assert.ok(current);
  assert.equal(current!.text, "second goal");
});

test("状态流转 — active → paused → active → achieved", () => {
  goal.setGoal("state transitions");

  let state = goal.getGoal();
  assert.equal(state!.status, "active");

  goal.updateGoal({ status: "paused" });
  state = goal.getGoal();
  assert.equal(state!.status, "paused");

  goal.updateGoal({ status: "active" });
  state = goal.getGoal();
  assert.equal(state!.status, "active");

  goal.updateGoal({ status: "achieved", achievedAt: Date.now() });
  state = goal.getGoal();
  assert.equal(state!.status, "achieved");
  assert.ok(state!.achievedAt! > 0);
});

test("Architecture invariant — core/goal/index.ts 中无 @earendil import", () => {
  const sourcePath = join(originalCwd, "core", "goal", "index.ts");
  const source = readFileSync(sourcePath, "utf-8");
  assert.ok(!source.includes("@earendil"), "core/goal must not import @earendil packages");
});
