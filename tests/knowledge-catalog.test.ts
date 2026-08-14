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

let originalCwd: string;
let originalHome: string | undefined;
let sandbox: string;
let workspaceRoot: string;
let projectRoot: string;
let homeRoot: string;
let featureRoot: string;
let contextReference: typeof import("../core/context-reference/index.ts");

before(async () => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-catalog-test-")));
  workspaceRoot = join(sandbox, "workspace");
  projectRoot = join(workspaceRoot, "packages", "app");
  homeRoot = join(sandbox, "home");
  featureRoot = join(projectRoot, "src", "feature");

  mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
  mkdirSync(featureRoot, { recursive: true });
  mkdirSync(homeRoot, { recursive: true });
  writeFileSync(
    join(workspaceRoot, "KNOWLEDGE.md"),
    "## Always\nWORKSPACE-RULE\n\n## Areas\n- packages/app/KNOWLEDGE.md | app catalog\n\n## Notes\nWORKSPACE-ROOT-BODY\n",
    "utf-8",
  );
  writeFileSync(
    join(projectRoot, "KNOWLEDGE.md"),
    "## Always\nPROJECT-RULE\n\n## Areas\n- src/feature/KNOWLEDGE.md | feature catalog\n\n## Notes\nPROJECT-ROOT-BODY\n",
    "utf-8",
  );
  writeFileSync(join(featureRoot, "KNOWLEDGE.md"), "NESTED-SCOPE-BODY\n", "utf-8");

  process.env.HOME = homeRoot;
  process.chdir(projectRoot);
  contextReference = await import(`../core/context-reference/index.ts?catalog=${Date.now()}`);
});

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(sandbox, { recursive: true, force: true });
});

test("首次快照常驻三层 index 与 project/workspace Areas 导航位置", () => {
  const snapshot = contextReference.buildKnowledgeSnapshot();

  assert.match(snapshot.content, /knowledge-catalog:/);
  assert.match(snapshot.content, new RegExp(`project-index: ${join(projectRoot, "knowledge", "index.md")}`));
  assert.match(snapshot.content, new RegExp(`workspace-index: ${join(workspaceRoot, "knowledge", "index.md")}`));
  assert.match(snapshot.content, new RegExp(`global-index: ${join(homeRoot, ".pi-harness", "knowledge", "index.md")}`));
  assert.match(snapshot.content, /project-areas:/);
  assert.match(snapshot.content, /src\/feature\/KNOWLEDGE\.md \| feature catalog/);
  assert.match(snapshot.content, /workspace-areas:/);
  assert.match(snapshot.content, /packages\/app\/KNOWLEDGE\.md \| app catalog/);
  assert.doesNotMatch(snapshot.content, /PROJECT-ROOT-BODY/);
  assert.doesNotMatch(snapshot.content, /WORKSPACE-ROOT-BODY/);
  assert.doesNotMatch(snapshot.content, /NESTED-SCOPE-BODY/);
});

test("目录正文只在 scope 激活后进入快照", () => {
  const snapshot = contextReference.buildKnowledgeSnapshot([featureRoot]);

  assert.match(snapshot.content, /scope\(packages\/app\/src\/feature\):/);
  assert.match(snapshot.content, /NESTED-SCOPE-BODY/);
});

test("已常驻的 project/workspace 根不会作为 active scope 重复注入", () => {
  const snapshot = contextReference.buildKnowledgeSnapshot([projectRoot, workspaceRoot]);

  assert.equal(snapshot.content.match(/PROJECT-RULE/g)?.length, 1);
  assert.equal(snapshot.content.match(/WORKSPACE-RULE/g)?.length, 1);
  assert.equal(snapshot.content.match(/PROJECT-ROOT-BODY/g)?.length, 1);
  assert.equal(snapshot.content.match(/WORKSPACE-ROOT-BODY/g)?.length, 1);
});
