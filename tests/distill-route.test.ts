import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
let boardTool: any;

before(async () => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-distill-test-")));
  projectDir = join(sandbox, "project");
  nestedCwd = join(projectDir, "src", "feature");
  const homeDir = join(sandbox, "home");
  mkdirSync(join(projectDir, ".git"), { recursive: true });
  mkdirSync(nestedCwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
  process.chdir(nestedCwd);
  projectRoot = join(nestedCwd, "knowledge");
  workspaceRoot = join(projectDir, "knowledge");
  globalRoot = join(homeDir, ".pi-harness", "knowledge");

  const registerExtension = (await import(`../extensions/board.ts?test=${Date.now()}`)).default;
  await registerExtension({ registerTool(tool: any) { boardTool = tool; } });
});

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(sandbox, { recursive: true, force: true });
});

async function run(params: Record<string, unknown>): Promise<string> {
  const result = await boardTool.execute("test-call", params, undefined, undefined, {});
  return result.content[0].text as string;
}

test("action 与 scope schema 包含三层 distill 路由", () => {
  const actions = boardTool.parameters.properties.action.anyOf.map((type: any) => type.const);
  const scopes = boardTool.parameters.properties.scope.anyOf.map((type: any) => type.const);
  assert.ok(actions.includes("distill"));
  assert.ok(actions.includes("distill-conflict"));
  assert.deepEqual(scopes, ["project", "workspace", "global"]);
});

test("distill 缺 source 被拒绝，默认写当前子项目根", async () => {
  const rejected = await run({
    action: "distill",
    path: "findings/route-a.md",
    content: "Conclusion without source.",
    description: "route test A",
  });
  assert.match(rejected, /Source link/);
  assert.equal(existsSync(join(projectRoot, "findings", "route-a.md")), false);

  const ok = await run({
    action: "distill",
    path: "findings/route-a.md",
    content: "A distilled conclusion.",
    source: "topic-route#seq-2",
    description: "route test A",
  });
  assert.match(ok, /Distilled entry "findings\/route-a\.md" \(project,/);
  assert.ok(ok.includes(join(projectRoot, "index.md")));
  assert.match(readFileSync(join(projectRoot, "findings", "route-a.md"), "utf-8"), /来源: topic-route#seq-2/);
  assert.equal(existsSync(join(globalRoot, "findings", "route-a.md")), false);
});

test("distill scope=global 写隔离全局根", async () => {
  const ok = await run({
    action: "distill",
    path: "shared/route-g.md",
    content: "A cross-project technique.",
    source: "topic-route#seq-5",
    description: "route test G",
    scope: "global",
  });
  assert.match(ok, /Distilled entry "shared\/route-g\.md" \(global,/);
  assert.match(readFileSync(join(globalRoot, "shared", "route-g.md"), "utf-8"), /topic-route#seq-5/);
  assert.equal(existsSync(join(projectRoot, "shared", "route-g.md")), false);
});

test("distill scope=workspace 写共享 Git 根", async () => {
  const ok = await run({
    action: "distill",
    path: "shared/route-w.md",
    content: "A rule shared by sibling subprojects.",
    source: "topic-route#seq-6",
    description: "route test W",
    scope: "workspace",
  });
  assert.match(ok, /Distilled entry "shared\/route-w\.md" \(workspace,/);
  assert.match(readFileSync(join(workspaceRoot, "shared", "route-w.md"), "utf-8"), /topic-route#seq-6/);
  assert.equal(existsSync(join(projectRoot, "shared", "route-w.md")), false);
});

test("distill-conflict 正向验证 project/workspace/global scope", async () => {
  const projectOriginal = readFileSync(join(projectRoot, "findings", "route-a.md"), "utf-8");
  const projectResult = await run({
    action: "distill-conflict",
    path: "findings/route-a.md",
    source: "topic-route#seq-7",
    description: "Later evidence contradicts A.",
  });
  assert.match(projectResult, /\(project,/);
  assert.ok(readFileSync(join(projectRoot, "findings", "route-a.md"), "utf-8").startsWith(projectOriginal));

  const globalOriginal = readFileSync(join(globalRoot, "shared", "route-g.md"), "utf-8");
  const globalResult = await run({
    action: "distill-conflict",
    path: "shared/route-g.md",
    source: "topic-route#seq-8",
    description: "Later global evidence.",
    scope: "global",
  });
  assert.match(globalResult, /\(global,/);
  const globalUpdated = readFileSync(join(globalRoot, "shared", "route-g.md"), "utf-8");
  assert.ok(globalUpdated.startsWith(globalOriginal));
  assert.match(globalUpdated, /topic-route#seq-8/);

  const workspaceOriginal = readFileSync(join(workspaceRoot, "shared", "route-w.md"), "utf-8");
  const workspaceResult = await run({
    action: "distill-conflict",
    path: "shared/route-w.md",
    source: "topic-route#seq-9",
    description: "Later workspace evidence.",
    scope: "workspace",
  });
  assert.match(workspaceResult, /\(workspace,/);
  assert.ok(readFileSync(join(workspaceRoot, "shared", "route-w.md"), "utf-8").startsWith(workspaceOriginal));
});

test("board 路由拒绝越界且不留下部分写入", async () => {
  const result = await run({
    action: "distill",
    path: "../escaped.md",
    content: "outside",
    source: "topic-route#seq-9",
    description: "escape",
  });
  assert.match(result, /escapes the project root/);
  assert.equal(existsSync(join(nestedCwd, "escaped.md")), false);
});
