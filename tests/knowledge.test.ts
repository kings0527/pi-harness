import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalCwd: string;
let originalHome: string | undefined;
let sandbox: string;
let projectDir: string;
let nestedCwd: string;
let projectRoot: string;
let workspaceRoot: string;
let globalRoot: string;
let knowledge: typeof import("../core/knowledge/index.ts");

before(async () => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-knowledge-test-")));
  projectDir = join(sandbox, "project");
  nestedCwd = join(projectDir, "packages", "app");
  const homeDir = join(sandbox, "home");
  mkdirSync(join(projectDir, ".git"), { recursive: true });
  mkdirSync(nestedCwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  process.chdir(nestedCwd);

  projectRoot = join(nestedCwd, "knowledge");
  workspaceRoot = join(projectDir, "knowledge");
  globalRoot = join(homeDir, ".pi-harness", "knowledge");
  knowledge = await import(`../core/knowledge/index.ts?test=${Date.now()}`);
});

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(sandbox, { recursive: true, force: true });
});

test("project 使用会话根、workspace 使用 Git 根；读取不创建目录", () => {
  assert.equal(knowledge.getProjectRoot(), nestedCwd);
  assert.equal(knowledge.getWorkspaceRoot(), projectDir);
  assert.equal(knowledge.getKnowledgeRoot(), projectRoot);
  assert.equal(knowledge.getKnowledgeRoot("workspace"), workspaceRoot);
  assert.equal(knowledge.getKnowledgeRoot("global"), globalRoot);
  assert.equal(knowledge.getIndex().length, 0);
  assert.equal(knowledge.getIndex("workspace").length, 0);
  assert.equal(knowledge.getIndex("global").length, 0);
  assert.equal(knowledge.getEntry("missing.md"), null);
  assert.equal(knowledge.getEntry("missing.md", "workspace"), null);
  assert.equal(knowledge.getEntry("missing.md", "global"), null);
  assert.equal(existsSync(projectRoot), false);
  assert.equal(existsSync(workspaceRoot), false);
  assert.equal(existsSync(globalRoot), false);
});

test("addEntry 拒绝无溯源或多行索引字段", () => {
  assert.throws(
    () => knowledge.addEntry("unsourced.md", "content", "", "desc"),
    /Source link/,
  );
  assert.throws(
    () => knowledge.addEntry("bad-description.md", "content", "topic#1", "line 1\nline 2"),
    /Description/,
  );
  assert.equal(existsSync(projectRoot), false);
});

test("entry path 不得越界、使用绝对路径、占用 index.md 或穿过 symlink", () => {
  const sibling = join(nestedCwd, "escaped.md");
  assert.throws(
    () => knowledge.addEntry("../escaped.md", "outside", "topic#1", "escape"),
    /escapes/,
  );
  assert.equal(existsSync(sibling), false);

  assert.throws(
    () => knowledge.addEntry(join(sandbox, "absolute.md"), "outside", "topic#1", "absolute"),
    /must be relative/,
  );
  assert.throws(
    () => knowledge.addEntry("index.md", "reserved", "topic#1", "reserved"),
    /reserved/,
  );

  const outsideDir = join(sandbox, "outside");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  symlinkSync(outsideDir, join(projectRoot, "linked"), "dir");
  assert.throws(
    () => knowledge.addEntry("linked/escaped.md", "outside", "topic#1", "symlink"),
    /symlink/,
  );
  assert.equal(existsSync(join(outsideDir, "escaped.md")), false);

  const victim = join(projectDir, "victim.md");
  writeFileSync(victim, "original", "utf-8");
  assert.throws(
    () => knowledge.markConflict("../victim.md", "topic#2", "must stay unchanged"),
    /escapes/,
  );
  assert.equal(readFileSync(victim, "utf-8"), "original");
});

test("默认 scope=project 写项目根并精确更新 index", () => {
  const entryPath = "findings/finding-a.md";
  knowledge.addEntry(entryPath, "A project-level conclusion.", "topic-test#seq-3", "test entry A");

  const written = readFileSync(join(projectRoot, entryPath), "utf-8");
  assert.match(written, /A project-level conclusion\./);
  assert.match(written, /来源: topic-test#seq-3/);
  assert.equal(existsSync(join(globalRoot, entryPath)), false);
  assert.deepEqual(knowledge.getIndex(), [{ path: entryPath, description: "test entry A" }]);

  assert.throws(
    () => knowledge.addEntry(entryPath, "other", "topic-test#seq-9", "duplicate"),
    /already exists/,
  );
});

test("scope=global 仅写隔离的临时 HOME", () => {
  const entryPath = "shared/finding-g.md";
  knowledge.addEntry(entryPath, "A cross-project technique.", "topic-test#seq-4", "test entry G", "global");

  assert.match(readFileSync(join(globalRoot, entryPath), "utf-8"), /cross-project technique/);
  assert.equal(existsSync(join(projectRoot, entryPath)), false);
  assert.ok(knowledge.getIndex("global").some(entry => entry.path === entryPath));
  assert.ok(!knowledge.getIndex().some(entry => entry.path === entryPath));
});

test("scope=workspace 写共享 Git 根且不污染当前子项目或 global", () => {
  const entryPath = "shared/workspace-rule.md";
  knowledge.addEntry(
    entryPath,
    "A rule shared by related subprojects.",
    "topic-test#seq-6",
    "workspace rule",
    "workspace",
  );

  assert.match(readFileSync(join(workspaceRoot, entryPath), "utf-8"), /related subprojects/);
  assert.equal(existsSync(join(projectRoot, entryPath)), false);
  assert.equal(existsSync(join(globalRoot, entryPath)), false);
  assert.ok(knowledge.getIndex("workspace").some(entry => entry.path === entryPath));
});

test("会话位于 workspace 根时 project/workspace index 同根去重", async () => {
  const contextReference = await import("../core/context-reference/index.ts");
  process.chdir(projectDir);
  try {
    const snapshot = contextReference.buildKnowledgeSnapshot();
    assert.match(snapshot.content, /knowledge\(project\+workspace:/);
    assert.equal(snapshot.content.match(/shared\/workspace-rule\.md/g)?.length, 1);
    const catalog = snapshot.content.split("\n\n", 1)[0];
    const sharedIndexPath = join(projectDir, "knowledge", "index.md");
    const sharedAreasPath = `${join(projectDir, "KNOWLEDGE.md")}#Areas`;
    assert.match(catalog, /project\+workspace-index:/);
    assert.match(catalog, /project\+workspace-areas:/);
    assert.equal(catalog.split(sharedIndexPath).length - 1, 1);
    assert.equal(catalog.split(sharedAreasPath).length - 1, 1);
  } finally {
    process.chdir(nestedCwd);
  }
});

test("getEntry 按 scope 隔离读取", () => {
  assert.match(knowledge.getEntry("findings/finding-a.md")!, /project-level/);
  assert.equal(knowledge.getEntry("findings/finding-a.md", "global"), null);
  assert.match(knowledge.getEntry("shared/finding-g.md", "global")!, /cross-project/);
  assert.equal(knowledge.getEntry("shared/finding-g.md"), null);
  assert.match(knowledge.getEntry("shared/workspace-rule.md", "workspace")!, /related subprojects/);
  assert.equal(knowledge.getEntry("shared/workspace-rule.md"), null);
});

test("markConflict 在 project/workspace/global 均只追加并保留原文", () => {
  const projectPath = "findings/finding-b.md";
  knowledge.addEntry(projectPath, "Original project claim.", "topic-test#seq-5", "test entry B");
  const projectOriginal = readFileSync(join(projectRoot, projectPath), "utf-8");
  knowledge.markConflict(projectPath, "topic-test#seq-8", "New evidence contradicts the project claim.");
  const projectUpdated = readFileSync(join(projectRoot, projectPath), "utf-8");
  assert.ok(projectUpdated.startsWith(projectOriginal));
  assert.match(projectUpdated, /## ⚠️ CONFLICT/);

  const globalPath = "shared/finding-g.md";
  const globalOriginal = readFileSync(join(globalRoot, globalPath), "utf-8");
  knowledge.markConflict(globalPath, "topic-test#seq-10", "New global evidence.", "global");
  const globalUpdated = readFileSync(join(globalRoot, globalPath), "utf-8");
  assert.ok(globalUpdated.startsWith(globalOriginal));
  assert.match(globalUpdated, /来源: topic-test#seq-10/);

  const workspacePath = "shared/workspace-rule.md";
  const workspaceOriginal = readFileSync(join(workspaceRoot, workspacePath), "utf-8");
  knowledge.markConflict(workspacePath, "topic-test#seq-11", "New workspace evidence.", "workspace");
  const workspaceUpdated = readFileSync(join(workspaceRoot, workspacePath), "utf-8");
  assert.ok(workspaceUpdated.startsWith(workspaceOriginal));
  assert.match(workspaceUpdated, /来源: topic-test#seq-11/);
});

test("auditIndex 报告缺失和越界行但不自动清理", () => {
  const indexPath = join(projectRoot, "index.md");
  const before = readFileSync(indexPath, "utf-8");
  writeFileSync(indexPath, `${before}missing.md | stale\n../outside.md | invalid\n`, "utf-8");

  assert.deepEqual(knowledge.auditIndex(), [
    { path: "missing.md", reason: "missing" },
    {
      path: "../outside.md",
      reason: "invalid",
      detail: 'Knowledge entry path escapes the project root: "../outside.md"',
    },
  ]);
  assert.match(readFileSync(indexPath, "utf-8"), /missing\.md \| stale/);
});
