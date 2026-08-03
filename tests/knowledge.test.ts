import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// knowledge root is now global: ~/.pi-harness/knowledge/
// Tests write into a __test__/ subdirectory and restore index.md after.
const knowledgeRoot = join(homedir(), ".pi-harness", "knowledge");
const indexPath = join(knowledgeRoot, "index.md");
const testSubdir = join(knowledgeRoot, "__test__");

let workDir: string;
let indexSnapshot: string | null;
let knowledge: typeof import("../core/knowledge/index.ts");

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-knowledge-test-"));
  process.chdir(workDir);
  // Ensure global knowledge dir exists
  if (!existsSync(knowledgeRoot)) {
    mkdirSync(knowledgeRoot, { recursive: true });
  }
  // Clean up leftover test artifacts from previous runs
  rmSync(testSubdir, { recursive: true, force: true });
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
