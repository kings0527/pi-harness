import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let fakeHome: string;
let originalCwd: string;
let originalHome: string | undefined;
let flux: typeof import("../core/flux/index.ts");
let identity: typeof import("../core/identity/index.ts");
let fluxExt: typeof import("../extensions/flux.ts");

before(async () => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-flux-test-"));
  fakeHome = mkdtempSync(join(tmpdir(), "pi-harness-flux-home-"));
  process.env.HOME = fakeHome;
  process.chdir(workDir);
  flux = await import("../core/flux/index.ts");
  identity = await import("../core/identity/index.ts");
  fluxExt = await import("../extensions/flux.ts");
});

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

// Group 1: 零配置默认开启、全局/项目分层与多渠道 provider/id 解析
test("getFluxConfig 缺失文件时默认开启（零门槛自然语言即用）", () => {
  const config = flux.getFluxConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.configured, false);
  assert.equal(config.source, "default");
  assert.equal(flux.isFluxDisabled(config), false);
  assert.deepEqual(config.models, []);
  assert.equal(config.tentacles, undefined);
  assert.equal(config.mode, undefined);

  assert.deepEqual(
    flux.resolveFluxModels(config, "ollama/deepseek-v4.1-flash:1017"),
    ["ollama/deepseek-v4.1-flash:1017"],
  );
  assert.deepEqual(
    flux.resolveFluxModels(config, "ollama/deepseek-v4.1-flash:1017", ["deepseek/deepseek-flash"]),
    ["deepseek/deepseek-flash"],
  );
});

test("全局配置与项目覆盖分层、显式关闭与回退", () => {
  flux.setFluxConfig(
    {
      enabled: true,
      models: ["deepseek/deepseek-flash", "ollama/deepseek-v4.1-flash:1017"],
      tentacles: 4,
      mode: "shared",
    },
    "global",
  );
  const fromGlobal = flux.getFluxConfig();
  assert.equal(fromGlobal.source, "global");
  assert.deepEqual(fromGlobal.models, ["deepseek/deepseek-flash", "ollama/deepseek-v4.1-flash:1017"]);
  assert.equal(fromGlobal.tentacles, 4);

  // 项目覆盖优先于全局
  flux.setFluxConfig(
    {
      enabled: true,
      models: ["zai-coding-cn/glm-5.3"],
      tentacles: 3,
      mode: "worktree",
    },
    "project",
  );
  const fromProject = flux.getFluxConfig();
  assert.equal(fromProject.source, "project");
  assert.deepEqual(fromProject.models, ["zai-coding-cn/glm-5.3"]);
  assert.equal(fromProject.mode, "worktree");

  // 显式关闭必须被 isFluxDisabled 识别
  flux.setFluxConfig({ enabled: false, models: [] }, "project");
  const disabled = flux.getFluxConfig();
  assert.equal(flux.isFluxDisabled(disabled), true);

  // 删除项目覆盖后恢复全局配置
  assert.equal(flux.clearProjectFluxConfig(), true);
  assert.equal(existsSync(join(workDir, ".pi-board", "flux.json")), false);
  const restored = flux.getFluxConfig();
  assert.equal(restored.source, "global");
  assert.equal(flux.isFluxDisabled(restored), false);
});

test("setFluxConfig 原子写且不泄露运行时元数据字段", () => {
  flux.setFluxConfig(
    { enabled: true, models: ["deepseek/deepseek-flash"], tentacles: 2, mode: "shared", configured: true, source: "project" },
    "project",
  );
  const raw = readFileSync(join(workDir, ".pi-board", "flux.json"), "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.enabled, true);
  assert.deepEqual(parsed.models, ["deepseek/deepseek-flash"]);
  assert.equal(parsed.mode, "shared");
  assert.equal(parsed.configured, undefined);
  assert.equal(parsed.source, undefined);
  flux.clearProjectFluxConfig();
});

// Group 2: TUI 空格多选与多渠道 provider/id 模糊解析
test("extensions/flux.ts 保留多渠道 provider/id 并支持 TUI 空格勾选自动保存", async () => {
  const available = [
    { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash" },
    { provider: "ollama", id: "deepseek-flash", name: "Local DeepSeek Flash" },
    { provider: "zai-coding-cn", id: "glm-5.3", name: "GLM 5.3" },
  ];

  const matchedOllama = fluxExt.fuzzyMatchModel("ollama/deepseek-flash", available);
  assert.equal(matchedOllama && fluxExt.formatModelSpec(matchedOllama), "ollama/deepseek-flash");

  const matchedPreferred = fluxExt.fuzzyMatchModel("deepseek-flash", available, "ollama");
  assert.equal(matchedPreferred && fluxExt.formatModelSpec(matchedPreferred), "ollama/deepseek-flash");

  let command: any;
  const messages: any[] = [];
  await fluxExt.default({
    registerCommand(name: string, def: any) {
      if (name === "flux") command = def;
    },
    sendMessage(msg: any) {
      messages.push(msg);
    },
  });
  assert.ok(command);

  flux.setFluxConfig({ enabled: true, models: [] }, "global");

  let renderCount = 0;
  const ctx = {
    mode: "tui",
    model: { provider: "deepseek", id: "deepseek-flash" },
    modelRegistry: { getAvailable: () => available },
    ui: {
      custom(factory: any) {
        return new Promise((resolve) => {
          const comp = factory(
            { requestRender() { renderCount += 1; } },
            { fg: (_t: string, s: string) => s, bold: (s: string) => s },
            {},
            resolve,
          );
          const initialLines = comp.render(80);
          assert.ok(initialLines.some((l: string) => l.includes("deepseek/deepseek-flash")));
          comp.handleInput(" ");
          comp.handleInput("\x1b[B");
          comp.handleInput("\x1b[32u");
          comp.handleInput("m");
          comp.handleInput("\r");
        });
      },
    },
  };

  await command.handler("", ctx);
  assert.ok(renderCount >= 4);

  const saved = flux.getFluxConfig();
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.models, ["deepseek/deepseek-flash", "ollama/deepseek-flash"]);
  assert.equal(saved.mode, "worktree");
});

// Group 3: 起手认知姿态（破除初始对称性，支持自定义）
test("pickStartingLenses 自动轮配正交姿态并支持主模型自定义", () => {
  const auto = flux.pickStartingLenses(3);
  assert.deepEqual(auto.map((l) => l.id), ["spine", "seam", "probe"]);

  const custom = flux.pickStartingLenses(3, ["invert", "dynamic memory hook"]);
  assert.equal(custom[0].id, "invert");
  assert.equal(custom[1].name, "dynamic memory hook");
  assert.equal(custom[2].id, "probe");
});

// Group 4: 领域无关的道级纪律（零具体工具术例、无僵硬 NO OVERLAP）
test("tentacle profile 的 renderSystemPrompt 保持领域无关的道级纪律", () => {
  const profile = identity.loadProfile("tentacle");
  assert.equal(profile.interactionMode, "explore");
  const prompt = identity.renderSystemPrompt(profile, "test-topic", "test goal");
  assert.match(prompt, /COLLECTIVE INTELLIGENCE DISCIPLINE \(Live Flux\)/);
  assert.match(prompt, /DRIVE BY WORLD FEEDBACK/);
  assert.match(prompt, /OBJECTIVE ECHOES ONLY/);
  assert.match(prompt, /COHERENT OVERLAP/);
  assert.match(prompt, /CONVERGE ON BREACH/);
  assert.doesNotMatch(prompt, /NO OVERLAP:/);
  assert.doesNotMatch(prompt, /Frida|SSH|USB/i);
});

test("live field 模式下 renderSystemPrompt 精简提示并避免重复完整纪律", () => {
  const profile = identity.loadProfile("tentacle");
  const prompt = identity.renderSystemPrompt(profile, "test-topic", "test goal", {
    fieldId: "demo-field",
    actorLabel: "t1-seam",
    lens: "seam",
    lensGuidance: "inspect boundaries",
    artifactsPath: "/tmp/artifacts",
  });
  assert.match(prompt, /t1-seam/);
  assert.match(prompt, /Live Field: "demo-field"/);
  assert.match(prompt, /Starting lens \(decaying initial bias\): seam/);
  assert.doesNotMatch(prompt, /COLLECTIVE INTELLIGENCE DISCIPLINE \(Live Flux\)/);
});

test("非 explore 模式不包含 flux 纪律", () => {
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
