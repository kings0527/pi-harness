import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ADR-0011: two fixed tiers — project (<cwd>/knowledge/, default) and
// global (~/.pi-harness/knowledge/). Tests chdir into a temp workDir for the
// project tier; global-tier tests write into a __test__/ subdir and restore
// index.md after.
const globalRoot = join(homedir(), ".pi-harness", "knowledge");
const globalIndexPath = join(globalRoot, "index.md");
const globalTestSubdir = join(globalRoot, "__test__");

let workDir: string;
let projectRoot: string;
let globalIndexSnapshot: string | null;
let knowledge: typeof import("../core/knowledge/index.ts");

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-knowledge-test-"));
  process.chdir(workDir);
  projectRoot = join(workDir, "knowledge");
  // Ensure global knowledge dir exists
  if (!existsSync(globalRoot)) {
    mkdirSync(globalRoot, { recursive: true });
  }
  // Clean up leftover test artifacts from previous runs
  rmSync(globalTestSubdir, { recursive: true, force: true });
  globalIndexSnapshot = existsSync(globalIndexPath) ? readFileSync(globalIndexPath, "utf-8") : null;
  knowledge = await import("../core/knowledge/index.ts");
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

test("addEntry 拒绝无溯源条目（溯源校验）", () => {
  assert.throws(
    () => knowledge.addEntry("unsourced.md", "content", "", "desc"),
    /Source link is required/
  );
  assert.throws(
    () => knowledge.addEntry("unsourced.md", "content", "   ", "desc"),
    /Source link is required/
  );
  assert.ok(!existsSync(join(projectRoot, "unsourced.md")));
});

test("默认 scope=project 写入 <cwd>/knowledge/ 并更新项目 index.md，重复路径抛错", () => {
  const entryPath = "findings/finding-a.md";
  knowledge.addEntry(entryPath, "A project-level conclusion.", "topic-test#seq-3", "test entry A");

  const written = readFileSync(join(projectRoot, entryPath), "utf-8");
  assert.match(written, /A project-level conclusion\./);
  assert.match(written, /来源: topic-test#seq-3/);
  // 项目级条目绝不写进全局根
  assert.ok(!existsSync(join(globalRoot, entryPath)));

  const index = knowledge.getIndex();
  const row = index.find(e => e.path === entryPath);
  assert.ok(row, "项目 index.md 应包含新条目");
  assert.equal(row.description, "test entry A");

  assert.throws(
    () => knowledge.addEntry(entryPath, "other", "topic-test#seq-9", "dup"),
    /already exists/
  );
});

test("scope=global 写入 ~/.pi-harness/knowledge/ 而非项目根", () => {
  const entryPath = "__test__/finding-g.md";
  knowledge.addEntry(entryPath, "A cross-project technique.", "topic-test#seq-4", "test entry G", "global");

  const written = readFileSync(join(globalRoot, entryPath), "utf-8");
  assert.match(written, /A cross-project technique\./);
  assert.ok(!existsSync(join(projectRoot, entryPath)), "全局条目绝不写进项目根");

  const globalIdx = knowledge.getIndex("global");
  assert.ok(globalIdx.some(e => e.path === entryPath));
  const projectIdx = knowledge.getIndex("project");
  assert.ok(!projectIdx.some(e => e.path === entryPath));
});

test("getEntry 按 scope 隔离读取", () => {
  assert.match(knowledge.getEntry("findings/finding-a.md")!, /project-level/);
  assert.equal(knowledge.getEntry("findings/finding-a.md", "global"), null);
  assert.match(knowledge.getEntry("__test__/finding-g.md", "global")!, /cross-project/);
  assert.equal(knowledge.getEntry("__test__/finding-g.md", "project"), null);
});

test("markConflict 只追加 CONFLICT 块，绝不改写原内容（双 scope 均验证）", () => {
  const entryPath = "findings/finding-b.md";
  knowledge.addEntry(entryPath, "Original claim.", "topic-test#seq-5", "test entry B");
  const original = readFileSync(join(projectRoot, entryPath), "utf-8");

  knowledge.markConflict(entryPath, "topic-test#seq-8", "New evidence contradicts the claim.");

  const updated = readFileSync(join(projectRoot, entryPath), "utf-8");
  assert.ok(updated.startsWith(original), "原内容必须原样保留在文件头部");
  assert.match(updated, /## ⚠️ CONFLICT/);
  assert.match(updated, /New evidence contradicts the claim\./);
  assert.match(updated, /来源: topic-test#seq-8/);

  assert.throws(
    () => knowledge.markConflict("missing.md", "topic-x#seq-1", "n/a"),
    /not found/
  );
  assert.throws(
    () => knowledge.markConflict("__test__/missing.md", "topic-x#seq-1", "n/a", "global"),
    /not found/
  );
});
