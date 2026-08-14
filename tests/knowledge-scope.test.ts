import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

test("findKnowledgeScope 拒绝同前缀兄弟目录并以 workspaceRoot 解析相对路径", () => {
  const prefixedSibling = `${workspaceRoot}-other`;
  mkdirSync(prefixedSibling, { recursive: true });
  writeFileSync(join(prefixedSibling, "KNOWLEDGE.md"), "outside scope\n", "utf-8");

  assert.equal(
    scope.findKnowledgeScope(join(prefixedSibling, "file.ts"), workspaceRoot),
    null,
  );
  assert.equal(
    scope.findKnowledgeScope("src/auth/login.ts", workspaceRoot),
    join(workspaceRoot, "src", "auth"),
  );
});

test("findKnowledgeScope 与 readScope 拒绝 symlink scope 路径和正文", () => {
  const outsideDir = join(sandbox, "outside-linked-scope");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, "KNOWLEDGE.md"), "outside linked scope\n", "utf-8");
  const linkedDir = join(workspaceRoot, "linked-outside");
  symlinkSync(outsideDir, linkedDir, "dir");
  const cache = new Map<string, import("../core/knowledge/scope.ts").ScopeEntry>();

  assert.equal(
    scope.findKnowledgeScope(join(linkedDir, "file.ts"), workspaceRoot),
    null,
  );
  assert.equal(scope.readScope(linkedDir, cache), null);
  assert.equal(scope.readScope(linkedDir, cache, workspaceRoot), null);
  assert.equal(scope.discoverScopes(linkedDir).size, 0);

  const linkedFileDir = join(workspaceRoot, "src", "linked-file-scope");
  mkdirSync(linkedFileDir, { recursive: true });
  symlinkSync(join(outsideDir, "KNOWLEDGE.md"), join(linkedFileDir, "KNOWLEDGE.md"));
  assert.equal(scope.readScope(linkedFileDir, cache), null);
  assert.ok(!scope.discoverScopes(workspaceRoot).has(linkedFileDir));
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

test("discoverScopes 超过 maxDirs 后全局终止且只告警一次", () => {
  const budgetRoot = join(sandbox, "budget-workspace");
  mkdirSync(budgetRoot, { recursive: true });
  writeFileSync(join(budgetRoot, "KNOWLEDGE.md"), "root scope\n", "utf-8");
  for (let index = 0; index < 10; index += 1) {
    const dir = join(budgetRoot, `scope-${index}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "KNOWLEDGE.md"), `scope ${index}\n`, "utf-8");
  }

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    const discovered = scope.discoverScopes(budgetRoot, 8, 2);
    assert.equal(discovered.size, 2, "root and only one child may be visited");
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(errors, [
    "[knowledge/scope] WARN: discoverScopes exceeded 2 directories, stopping scan",
  ]);
});

test("discoverScopes 正常规模不告警且不遍历目录符号链接", () => {
  const outside = join(sandbox, "outside-scope");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "KNOWLEDGE.md"), "outside scope\n", "utf-8");
  symlinkSync(outside, join(workspaceRoot, "linked-scope"), "dir");

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  let discovered: Map<string, import("../core/knowledge/scope.ts").ScopeEntry>;
  try {
    discovered = scope.discoverScopes(workspaceRoot, 8, 1000);
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 0);
  assert.ok(!discovered.has(join(workspaceRoot, "linked-scope")));
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
