import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// 验证 board 工具的 distill / distill-conflict action 真实路由到 core/knowledge。
// knowledge root is now global: ~/.pi-harness/knowledge/
const knowledgeRoot = join(homedir(), ".pi-harness", "knowledge");
const indexPath = join(knowledgeRoot, "index.md");
const testSubdir = join(knowledgeRoot, "__test__");

let workDir: string;
let indexSnapshot: string | null;
let boardTool: any;

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-distill-test-"));
  process.chdir(workDir);
  // Ensure global knowledge dir exists
  if (!existsSync(knowledgeRoot)) {
    mkdirSync(knowledgeRoot, { recursive: true });
  }
  // Clean up leftover test artifacts from previous runs
  rmSync(testSubdir, { recursive: true, force: true });
  indexSnapshot = existsSync(indexPath) ? readFileSync(indexPath, "utf-8") : null;

  // 假 pi：只捕获 registerTool 注册的工具定义
  const registerExtension = (await import("../extensions/board.ts")).default;
  const fakePi = { registerTool(def: any) { boardTool = def; }, on() {} };
  await registerExtension(fakePi);
  assert.ok(boardTool, "board 工具应完成注册");
});

after(() => {
  rmSync(testSubdir, { recursive: true, force: true });
  if (indexSnapshot !== null) {
    writeFileSync(indexPath, indexSnapshot, "utf-8");
  } else {
    rmSync(indexPath, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function run(params: Record<string, unknown>): Promise<string> {
  const result = await boardTool.execute("test-call", params, undefined, undefined, undefined);
  return result.content[0].text as string;
}

test("action 枚举包含 distill 与 distill-conflict", () => {
  const actions = boardTool.parameters.properties.action.anyOf.map((t: any) => t.const);
  assert.ok(actions.includes("distill"));
  assert.ok(actions.includes("distill-conflict"));
});

test("distill 写入 knowledge 条目并更新 index，缺 source 被拒绝", async () => {
  const rejected = await run({
    action: "distill",
    path: "__test__/route-a.md",
    content: "Conclusion without source.",
    description: "route test A",
  });
  assert.match(rejected, /Source link is required/);
  assert.ok(!existsSync(join(knowledgeRoot, "__test__", "route-a.md")));

  const ok = await run({
    action: "distill",
    path: "__test__/route-a.md",
    content: "A distilled conclusion.",
    source: "topic-route#seq-2",
    description: "route test A",
  });
  assert.match(ok, /Distilled entry "__test__\/route-a\.md"/);

  const written = readFileSync(join(knowledgeRoot, "__test__", "route-a.md"), "utf-8");
  assert.match(written, /来源: topic-route#seq-2/);
  assert.match(readFileSync(indexPath, "utf-8"), /__test__\/route-a\.md \| route test A/);
});

test("distill-conflict 只追加 CONFLICT 块，原内容保留", async () => {
  const original = readFileSync(join(knowledgeRoot, "__test__", "route-a.md"), "utf-8");

  const ok = await run({
    action: "distill-conflict",
    path: "__test__/route-a.md",
    source: "topic-route#seq-7",
    description: "Later evidence contradicts A.",
  });
  assert.match(ok, /Marked CONFLICT/);

  const updated = readFileSync(join(knowledgeRoot, "__test__", "route-a.md"), "utf-8");
  assert.ok(updated.startsWith(original), "原内容必须原样保留");
  assert.match(updated, /## ⚠️ CONFLICT/);
  assert.match(updated, /来源: topic-route#seq-7/);

  const missing = await run({
    action: "distill-conflict",
    path: "__test__/missing.md",
    source: "topic-route#seq-9",
    description: "n/a",
  });
  assert.match(missing, /not found/);
});
