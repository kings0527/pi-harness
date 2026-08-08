import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let physarum: typeof import("../core/physarum/index.ts");
let identity: typeof import("../core/identity/index.ts");

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-physarum-test-"));
  process.chdir(workDir);
  physarum = await import("../core/physarum/index.ts");
  identity = await import("../core/identity/index.ts");
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// Group 1: 配置
test("getPhysarumConfig 缺失文件返回默认值", () => {
  const config = physarum.getPhysarumConfig();
  assert.equal(config.enabled, false);
  assert.deepEqual(config.models, []);
  assert.equal(config.tentacles, undefined);
  assert.equal(config.maxPulses, undefined);
});

test("setPhysarumConfig → getPhysarumConfig 往返一致", () => {
  const input = { enabled: true, models: ["claude-sonnet-4", "deepseek-r1"], tentacles: 4, maxPulses: 3 };
  physarum.setPhysarumConfig(input);
  const result = physarum.getPhysarumConfig();
  assert.deepEqual(result, input);
});

test("setPhysarumConfig 原子写（文件存在且 JSON 合法）", () => {
  physarum.setPhysarumConfig({ enabled: true, models: ["test"], tentacles: 2, maxPulses: 2 });
  const raw = readFileSync(join(workDir, ".pi-board", "physarum.json"), "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.models, ["test"]);
});

// Group 2: 门禁校验（通过 spawn.ts 的 physarum action 逻辑，这里测纯配置层）
test("配置 enabled=false 时通过 getPhysarumConfig 可检测", () => {
  physarum.setPhysarumConfig({ enabled: false, models: [] });
  const config = physarum.getPhysarumConfig();
  assert.equal(config.enabled, false);
});

// Group 3: 纪律注入
test("tentacle profile 的 renderSystemPrompt 包含 COLLECTIVE INTELLIGENCE", () => {
  const profile = identity.loadProfile("tentacle");
  assert.equal(profile.interactionMode, "explore");
  const prompt = identity.renderSystemPrompt(profile, "test-topic", "test goal");
  assert.match(prompt, /COLLECTIVE INTELLIGENCE DISCIPLINE/);
  assert.match(prompt, /READ FIRST/);
  assert.match(prompt, /NO OVERLAP/);
});

test("非 explore 模式不包含 physarum 纪律", () => {
  const profile = identity.loadProfile("scout");
  const prompt = identity.renderSystemPrompt(profile, "test-topic", "test goal");
  assert.doesNotMatch(prompt, /COLLECTIVE INTELLIGENCE DISCIPLINE/);
});

test("debate 模式包含 DEBATE 但不包含 COLLECTIVE INTELLIGENCE", () => {
  const profile = identity.loadProfile("advocate");
  const prompt = identity.renderSystemPrompt(profile, "test-topic", "test goal");
  assert.match(prompt, /DEBATE DISCIPLINE/);
  assert.doesNotMatch(prompt, /COLLECTIVE INTELLIGENCE DISCIPLINE/);
});
