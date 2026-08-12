import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let sandbox: string;
let workspaceRoot: string;
let scope: typeof import("../core/knowledge/scope.ts");

before(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-scope-test-")));
  workspaceRoot = join(sandbox, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });

  // Build a directory tree with KNOWLEDGE.md files
  mkdirSync(join(workspaceRoot, "src", "auth"), { recursive: true });
  mkdirSync(join(workspaceRoot, "src", "payments"), { recursive: true });
  mkdirSync(join(workspaceRoot, "src", "utils"), { recursive: true });
  mkdirSync(join(workspaceRoot, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(workspaceRoot, ".git"), { recursive: true });

  writeFileSync(
    join(workspaceRoot, "KNOWLEDGE.md"),
    "## Always\nUse TypeScript strict mode.\n\n## Areas\n- src/auth: authentication\n- src/payments: billing\n\n## Other\nGeneral notes.\n",
    "utf-8",
  );
  writeFileSync(
    join(workspaceRoot, "src", "auth", "KNOWLEDGE.md"),
    "Auth module uses JWT tokens.\nNever store passwords in plain text.\n",
    "utf-8",
  );
  writeFileSync(
    join(workspaceRoot, "src", "payments", "KNOWLEDGE.md"),
    "Payments use Stripe API.\nAll amounts in cents.\n",
    "utf-8",
  );
  // This one should be skipped by discoverScopes
  writeFileSync(
    join(workspaceRoot, "node_modules", "dep", "KNOWLEDGE.md"),
    "Should not be discovered.\n",
    "utf-8",
  );

  scope = await import(`../core/knowledge/scope.ts?test=${Date.now()}`);
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test("findKnowledgeScope 向上查找最近的 KNOWLEDGE.md", () => {
  const filePath = join(workspaceRoot, "src", "auth", "login.ts");
  const result = scope.findKnowledgeScope(filePath, workspaceRoot);
  assert.equal(result, join(workspaceRoot, "src", "auth"));
});

test("findKnowledgeScope 跨目录向上直到 workspace root", () => {
  const filePath = join(workspaceRoot, "src", "utils", "helpers.ts");
  // utils 目录没有 KNOWLEDGE.md，src 也没有，最终到 workspace root
  const result = scope.findKnowledgeScope(filePath, workspaceRoot);
  assert.equal(result, workspaceRoot);
});

test("findKnowledgeScope 文件在 workspace 外返回 null", () => {
  const filePath = join(sandbox, "outside", "file.ts");
  const result = scope.findKnowledgeScope(filePath, workspaceRoot);
  assert.equal(result, null);
});

test("discoverScopes 递归发现所有 KNOWLEDGE.md，跳过 node_modules 和 .git", () => {
  const discovered = scope.discoverScopes(workspaceRoot);
  const dirs = [...discovered.keys()];

  assert.ok(dirs.includes(workspaceRoot), "root should be discovered");
  assert.ok(dirs.includes(join(workspaceRoot, "src", "auth")), "auth should be discovered");
  assert.ok(dirs.includes(join(workspaceRoot, "src", "payments")), "payments should be discovered");
  assert.ok(!dirs.some(d => d.includes("node_modules")), "node_modules should be skipped");

  const authEntry = discovered.get(join(workspaceRoot, "src", "auth"))!;
  assert.match(authEntry.content, /JWT tokens/);
  assert.ok(authEntry.mtimeMs > 0);
});

test("discoverScopes 受 maxDepth 限制", () => {
  const deepDir = join(workspaceRoot, "a", "b", "c", "d", "e");
  mkdirSync(deepDir, { recursive: true });
  writeFileSync(join(deepDir, "KNOWLEDGE.md"), "deep scope\n", "utf-8");

  const shallow = scope.discoverScopes(workspaceRoot, 2);
  assert.ok(!shallow.has(deepDir), "depth=2 should not reach 5-level deep");

  const deep = scope.discoverScopes(workspaceRoot, 8);
  assert.ok(deep.has(deepDir), "depth=8 should reach 5-level deep");
});

test("readScope 从缓存返回相同 mtime 的条目", () => {
  const cache = new Map<string, import("../core/knowledge/scope.ts").ScopeEntry>();
  const dir = join(workspaceRoot, "src", "auth");

  const first = scope.readScope(dir, cache);
  assert.ok(first !== null);
  assert.match(first!.content, /JWT tokens/);

  // Second call should return cached version
  const second = scope.readScope(dir, cache);
  assert.ok(second !== null);
  assert.equal(second!.content, first!.content);
  assert.equal(second!.mtimeMs, first!.mtimeMs);
});

test("readScope 对不存在的目录返回 null", () => {
  const cache = new Map<string, import("../core/knowledge/scope.ts").ScopeEntry>();
  const result = scope.readScope(join(workspaceRoot, "nonexistent"), cache);
  assert.equal(result, null);
});

test("extractRootSections 正确提取 Always 和 Areas 部分", () => {
  const content = "## Always\nRule 1\nRule 2\n\n## Areas\n- area1\n- area2\n\n## Other\nSomething else\n";
  const { always, areas, rest } = scope.extractRootSections(content);
  assert.match(always, /Rule 1/);
  assert.match(always, /Rule 2/);
  assert.match(areas, /area1/);
  assert.match(areas, /area2/);
  assert.match(rest, /Something else/);
  assert.doesNotMatch(rest, /Rule 1/);
  assert.doesNotMatch(rest, /area1/);
});

test("extractRootSections 没有 Always/Areas 时全部归入 rest", () => {
  const content = "## Overview\nJust some notes.\n\n## Details\nMore info.\n";
  const { always, areas, rest } = scope.extractRootSections(content);
  assert.equal(always, "");
  assert.equal(areas, "");
  assert.match(rest, /Just some notes/);
  assert.match(rest, /More info/);
});

test("extractRootSections 空内容返回空字符串", () => {
  const { always, areas, rest } = scope.extractRootSections("");
  assert.equal(always, "");
  assert.equal(areas, "");
  assert.equal(rest, "");
});
