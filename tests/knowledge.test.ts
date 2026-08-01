import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// knowledge 根锚定包根 knowledge/（core/knowledge 按 import.meta.dirname 解析），
// 测试只在唯一的 __test__/ 子目录内写入，并快照恢复 index.md，after 中彻底清理。
// appendEvent 依赖 process.cwd()/.pi-board，同样 chdir 到临时目录隔离。
const knowledgeRoot = join(import.meta.dirname, "..", "knowledge");
const indexPath = join(knowledgeRoot, "index.md");
const testSubdir = join(knowledgeRoot, "__test__");

let workDir: string;
let indexSnapshot: string | null;
let knowledge: typeof import("../core/knowledge/index.ts");

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-knowledge-test-"));
  process.chdir(workDir);
  indexSnapshot = existsSync(indexPath) ? readFileSync(indexPath, "utf-8") : null;
  knowledge = await import("../core/knowledge/index.ts");
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

test("addEntry 拒绝无溯源条目（溯源校验）", () => {
  assert.throws(
    () => knowledge.addEntry("__test__/unsourced.md", "content", "", "desc"),
    /Source link is required/
  );
  assert.throws(
    () => knowledge.addEntry("__test__/unsourced.md", "content", "   ", "desc"),
    /Source link is required/
  );
  assert.ok(!existsSync(join(knowledgeRoot, "__test__", "unsourced.md")));
});

test("addEntry 写入带来源尾注的条目并更新 index.md，重复路径抛错", () => {
  const entryPath = "__test__/finding-a.md";
  knowledge.addEntry(entryPath, "A reusable conclusion.", "topic-test#seq-3", "test entry A");

  const written = readFileSync(join(knowledgeRoot, entryPath), "utf-8");
  assert.match(written, /A reusable conclusion\./);
  assert.match(written, /来源: topic-test#seq-3/);

  const index = knowledge.getIndex();
  const row = index.find(e => e.path === entryPath);
  assert.ok(row, "index.md 应包含新条目");
  assert.equal(row.description, "test entry A");

  assert.throws(
    () => knowledge.addEntry(entryPath, "other", "topic-test#seq-9", "dup"),
    /already exists/
  );
});

test("markConflict 只追加 CONFLICT 块，绝不改写原内容", () => {
  const entryPath = "__test__/finding-b.md";
  knowledge.addEntry(entryPath, "Original claim.", "topic-test#seq-5", "test entry B");
  const original = readFileSync(join(knowledgeRoot, entryPath), "utf-8");

  knowledge.markConflict(entryPath, "topic-test#seq-8", "New evidence contradicts the claim.");

  const updated = readFileSync(join(knowledgeRoot, entryPath), "utf-8");
  assert.ok(updated.startsWith(original), "原内容必须原样保留在文件头部");
  assert.match(updated, /## ⚠️ CONFLICT/);
  assert.match(updated, /New evidence contradicts the claim\./);
  assert.match(updated, /来源: topic-test#seq-8/);

  assert.throws(
    () => knowledge.markConflict("__test__/missing.md", "topic-x#seq-1", "n/a"),
    /not found/
  );
});
