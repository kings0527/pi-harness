import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// 验证 board 工具的 distill / distill-conflict action 真实路由到 core/knowledge。
// ADR-0011: 默认 scope=project 写 <cwd>/knowledge/，scope=global 写 ~/.pi-harness/knowledge/。
const globalRoot = join(homedir(), ".pi-harness", "knowledge");
const globalIndexPath = join(globalRoot, "index.md");
const globalTestSubdir = join(globalRoot, "__test__");

let workDir: string;
let projectRoot: string;
let projectIndexPath: string;
let globalIndexSnapshot: string | null;
let boardTool: any;

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-distill-test-"));
  process.chdir(workDir);
  projectRoot = join(workDir, "knowledge");
  projectIndexPath = join(projectRoot, "index.md");
  // Ensure global knowledge dir exists
  if (!existsSync(globalRoot)) {
    mkdirSync(globalRoot, { recursive: true });
  }
  // Clean up leftover test artifacts from previous runs
  rmSync(globalTestSubdir, { recursive: true, force: true });
  globalIndexSnapshot = existsSync(globalIndexPath) ? readFileSync(globalIndexPath, "utf-8") : null;

  // 假 pi：只捕获 registerTool 注册的工具定义
  const registerExtension = (await import("../extensions/board.ts")).default;
  const fakePi = { registerTool(def: any) { boardTool = def; }, on() {} };
  await registerExtension(fakePi);
  assert.ok(boardTool, "board 工具应完成注册");
});

after(() => {
  rmSync(globalTestSubdir, { recursive: true, force: true });
  if (globalIndexSnapshot !== null) {
    writeFileSync(globalIndexPath, globalIndexSnapshot, "utf-8");
  } else {
    rmSync(globalIndexPath, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function run(params: Record<string, unknown>): Promise<string> {
  const result = await boardTool.execute("test-call", params, undefined, undefined, undefined);
  return result.content[0].text as string;
}

test("action 枚举包含 distill 与 distill-conflict，scope 枚举为 project|global", () => {
  const actions = boardTool.parameters.properties.action.anyOf.map((t: any) => t.const);
  assert.ok(actions.includes("distill"));
  assert.ok(actions.includes("distill-conflict"));
  const scopes = boardTool.parameters.properties.scope.anyOf.map((t: any) => t.const);
  assert.deepEqual(scopes, ["project", "global"]);
});

test("distill 缺 source 被拒绝，默认写入项目根 knowledge/", async () => {
  const rejected = await run({
    action: "distill",
    path: "findings/route-a.md",
    content: "Conclusion without source.",
    description: "route test A",
  });
  assert.match(rejected, /Source link is required/);
  assert.ok(!existsSync(join(projectRoot, "findings", "route-a.md")));

  const ok = await run({
    action: "distill",
    path: "findings/route-a.md",
    content: "A distilled conclusion.",
    source: "topic-route#seq-2",
    description: "route test A",
  });
  assert.match(ok, /Distilled entry "findings\/route-a\.md" \(project,/);

  const written = readFileSync(join(projectRoot, "findings", "route-a.md"), "utf-8");
  assert.match(written, /来源: topic-route#seq-2/);
  assert.match(readFileSync(projectIndexPath, "utf-8"), /findings\/route-a\.md \| route test A/);
  // 项目级条目绝不写进全局根
  assert.ok(!existsSync(join(globalRoot, "findings", "route-a.md")));
});

test("distill scope=global 写入全局根", async () => {
  const ok = await run({
    action: "distill",
    path: "__test__/route-g.md",
    content: "A cross-project technique.",
    source: "topic-route#seq-5",
    description: "route test G",
    scope: "global",
  });
  assert.match(ok, /Distilled entry "__test__\/route-g\.md" \(global,/);

  assert.match(readFileSync(join(globalRoot, "__test__", "route-g.md"), "utf-8"), /来源: topic-route#seq-5/);
  assert.match(readFileSync(globalIndexPath, "utf-8"), /__test__\/route-g\.md \| route test G/);
  assert.ok(!existsSync(join(projectRoot, "__test__", "route-g.md")));
});

test("distill-conflict 只追加 CONFLICT 块，原内容保留（按 scope 路由）", async () => {
  const original = readFileSync(join(projectRoot, "findings", "route-a.md"), "utf-8");

  const ok = await run({
    action: "distill-conflict",
    path: "findings/route-a.md",
    source: "topic-route#seq-7",
    description: "Later evidence contradicts A.",
  });
  assert.match(ok, /Marked CONFLICT on "findings\/route-a\.md" \(project,/);

  const updated = readFileSync(join(projectRoot, "findings", "route-a.md"), "utf-8");
  assert.ok(updated.startsWith(original), "原内容必须原样保留");
  assert.match(updated, /## ⚠️ CONFLICT/);
  assert.match(updated, /来源: topic-route#seq-7/);

  const missing = await run({
    action: "distill-conflict",
    path: "missing.md",
    source: "topic-route#seq-9",
    description: "n/a",
  });
  assert.match(missing, /not found/);

  const missingGlobal = await run({
    action: "distill-conflict",
    path: "__test__/missing.md",
    source: "topic-route#seq-9",
    description: "n/a",
    scope: "global",
  });
  assert.match(missingGlobal, /not found/);
});
