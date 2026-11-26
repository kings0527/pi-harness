import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let fakeHome: string;
let originalCwd: string;
let originalHome: string | undefined;
let field: typeof import("../core/field/index.ts");
let worktree: typeof import("../core/field/worktree.ts");
let fieldExt: typeof import("../extensions/field.ts").default;

before(async () => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-field-test-"));
  fakeHome = mkdtempSync(join(tmpdir(), "pi-harness-field-home-"));
  process.env.HOME = fakeHome;
  process.chdir(workDir);
  field = await import("../core/field/index.ts");
  worktree = await import("../core/field/worktree.ts");
  fieldExt = (await import("../extensions/field.ts")).default;
});

after(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

test("openField / listFields / closeField 基本生命周期与路径安全校验", () => {
  for (const unsafe of ["", "../escape", "a/b", ".hidden", ".."]) {
    assert.throws(() => field.openField(unsafe, "goal"), /Field ID/);
  }
  const meta = field.openField("hunt-1", "find auth bypass", {
    topic: "auth-hunt",
    mode: "shared",
    createdBy: "main",
  });
  assert.equal(meta.id, "hunt-1");
  assert.equal(meta.status, "active");
  assert.equal(meta.mode, "shared");
  assert.ok(existsSync(field.artifactsDir("hunt-1")));

  const listed = field.listFields();
  assert.ok(listed.some((f) => f.id === "hunt-1"));

  const closed = field.closeField("hunt-1");
  assert.equal(closed?.status, "closed");
});

test("独占物理资源（Frida/SSH）互斥、拒抢与死进程自动回收", () => {
  field.openField("dev-lock", "mobile hook test");

  const c1 = field.claimResource("dev-lock", "frida@pixel7", {
    actorId: "actor-a",
    label: "t1-probe",
    purpose: "hooking libfoo::verify",
  });
  assert.equal(c1.acquired, true);

  // 另一活跃触角尝试抢同一台手机 -> 拒绝并返回持有者信息
  const c2 = field.claimResource("dev-lock", "FRIDA@PIXEL7", {
    actorId: "actor-b",
    label: "t2-seam",
    purpose: "dumping keystore",
  });
  assert.equal(c2.acquired, false);
  assert.equal(c2.lease.holderId, "actor-a");
  assert.equal(c2.lease.purpose, "hooking libfoo::verify");

  // 非持有者不能释放他人租约
  assert.equal(field.releaseResource("dev-lock", "frida@pixel7", "actor-b"), false);
  assert.equal(field.listResources("dev-lock").length, 1);

  // 持有者可正常释放
  assert.equal(field.releaseResource("dev-lock", "frida@pixel7", "actor-a"), true);
  assert.equal(field.listResources("dev-lock").length, 0);

  // 模拟崩溃死进程残留租约 -> 自动识别并回收
  const resDir = join(workDir, ".pi-board", "fields", "dev-lock", "resources");
  const deadClaim = field.claimResource("dev-lock", "ssh@prod", {
    actorId: "dead-actor",
    label: "dead-t",
    purpose: "restarting nginx",
  });
  assert.equal(deadClaim.acquired, true);
  // 覆盖写入一个必定不存在的高 PID
  const deadFile = join(resDir, `${execFileSync("ls", [resDir], { encoding: "utf-8" }).trim().split("\n").find((n) => n.startsWith("ssh_prod"))!}`);
  writeFileSync(
    deadFile,
    JSON.stringify({ ...deadClaim.lease, pid: 99999999, processStart: "linux-start:1" }),
    "utf-8",
  );
  assert.equal(field.listResources("dev-lock").length, 0);

  const reclaimed = field.claimResource("dev-lock", "ssh@prod", {
    actorId: "actor-b",
    label: "t2-seam",
    purpose: "checking logs",
  });
  assert.equal(reclaimed.acquired, true);
  assert.equal(reclaimed.lease.holderId, "actor-b");

  const releasedAll = field.releaseAllResources("dev-lock", "actor-b");
  assert.deepEqual(releasedAll, ["ssh@prod"]);
});

test("buildSidelineDelta 抗噪静默、游标增量、重叠柔提醒与 breach 共振波", () => {
  field.openField("sideline-1", "trace token bug");
  field.updatePresence("sideline-1", {
    actorId: "a1",
    label: "t1-spine",
    lens: "spine",
    heading: "read src/auth.ts",
    targets: ["src/auth.ts"],
  });
  field.updatePresence("sideline-1", {
    actorId: "a2",
    label: "t2-seam",
    lens: "seam",
    heading: "read src/config.ts",
    targets: ["src/config.ts"],
  });

  let cursor = field.emptySidelineCursor();

  // 首次看到活跃队友
  const first = field.buildSidelineDelta("sideline-1", "a1", cursor, {
    currentTargets: ["src/auth.ts"],
  });
  assert.ok(first);
  assert.match(first.text, /LIVE:.*t2-seam/);
  assert.equal(first.hasBreach, false);
  cursor = first.nextCursor;

  // 静默步：无新脉冲、无锁变化、无重叠 -> 必须返回 null（零噪音）
  const quiet = field.buildSidelineDelta("sideline-1", "a1", cursor, {
    currentTargets: ["src/auth.ts"],
  });
  assert.equal(quiet, null);

  // 队友发出客观回声脉冲 -> 游标只增量投递这一条
  field.postPulse("sideline-1", {
    actorId: "a2",
    actorLabel: "t2-seam",
    lens: "seam",
    kind: "echo",
    anchor: "src/config.ts:44",
    fact: "Static inspection shows fallback secret triggers when ENV_KEY is empty",
    next: "verify runtime behavior with empty ENV_KEY",
  });
  const dPulse = field.buildSidelineDelta("sideline-1", "a1", cursor, {
    currentTargets: ["src/auth.ts"],
  });
  assert.ok(dPulse);
  assert.equal(dPulse.newPulses.length, 1);
  assert.match(dPulse.text, /#1 \[t2-seam\/seam\|echo\]/);
  assert.match(dPulse.text, /fallback secret/);
  cursor = dPulse.nextCursor;

  // 再次查询 -> 再次静默（不重复灌旧脉冲）
  assert.equal(
    field.buildSidelineDelta("sideline-1", "a1", cursor, { currentTargets: ["src/auth.ts"] }),
    null,
  );

  // 空间重叠（a1 也去碰 src/config.ts）-> 柔性 OVERLAP 提示而非禁止
  const dOverlap = field.buildSidelineDelta("sideline-1", "a1", cursor, {
    currentTargets: ["src/config.ts"],
  });
  assert.ok(dOverlap);
  assert.equal(dOverlap.overlaps.length, 1);
  assert.match(dOverlap.text, /OVERLAP:.*t2-seam.*src\/config\.ts.*orthogonal angle/);
  cursor = dOverlap.nextCursor;

  // 队友发出 breach 破墙波 -> 高亮 BREACH WAVE 且更新 meta.status
  field.postPulse("sideline-1", {
    actorId: "a2",
    actorLabel: "t2-seam",
    lens: "seam",
    kind: "breach",
    anchor: "src/config.ts:44",
    fact: "Reproduced bypass with empty ENV_KEY via curl -> HTTP 200",
  });
  assert.equal(field.getFieldMeta("sideline-1")?.status, "breached");

  const dBreach = field.buildSidelineDelta("sideline-1", "a1", cursor, {
    currentTargets: ["src/auth.ts"],
  });
  assert.ok(dBreach);
  assert.equal(dBreach.hasBreach, true);
  assert.match(dBreach.text, /BREACH WAVE/);
  assert.match(dBreach.text, /HTTP 200/);
  cursor = dBreach.nextCursor;

  // 同一 breach 不会二次重复播报
  assert.equal(
    field.buildSidelineDelta("sideline-1", "a1", cursor, { currentTargets: ["src/auth.ts"] }),
    null,
  );
});

test("多进程并发 postPulse 保持严格连续 seq 无丢行", async () => {
  field.openField("concurrent-1", "stress test pulses");
  const storageRoot = join(workDir, ".pi-board");
  const modulePath = join(originalCwd, "core/field/index.ts");
  const workers = 4;
  const perWorker = 8;

  await Promise.all(
    Array.from({ length: workers }, (_, w) =>
      new Promise<void>((resolvePromise, reject) => {
        const script = `
          import { postPulse } from ${JSON.stringify(modulePath)};
          for (let i = 0; i < ${perWorker}; i++) {
            postPulse("concurrent-1", {
              actorId: "w${w}",
              actorLabel: "worker-${w}",
              kind: "echo",
              fact: "worker ${w} echo " + i,
            }, ${JSON.stringify(storageRoot)});
          }
        `;
        const child = spawn("bun", ["-e", script], { stdio: "inherit" });
        child.on("close", (code) =>
          code === 0 ? resolvePromise() : reject(new Error(`worker ${w} exited ${code}`)),
        );
      }),
    ),
  );

  const pulses = field.readPulses("concurrent-1", undefined, storageRoot);
  assert.equal(pulses.length, workers * perWorker);
  assert.deepEqual(
    pulses.map((p) => p.seq),
    Array.from({ length: workers * perWorker }, (_, i) => i + 1),
  );
});

test("worktree 平行宇宙：物理代码隔离 + 跨宇宙共享同一侧线认知场", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "pi-harness-wt-repo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@local"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "wall.txt"), "intact\n", "utf-8");
    execFileSync("git", ["add", "wall.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

    const sharedRoot = join(repoDir, ".pi-board");
    field.openField("wt-siege", "parallel siege", {
      mode: "worktree",
      rootCwd: repoDir,
      storageRoot: sharedRoot,
    });

    const wt1 = worktree.createTentacleWorktree(repoDir, "wt-siege", "t1-probe", sharedRoot);
    const wt2 = worktree.createTentacleWorktree(repoDir, "wt-siege", "t2-seam", sharedRoot);

    // 宇宙 1 破坏性改写文件，宇宙 2 完全不受物理污染
    writeFileSync(join(wt1.path, "wall.txt"), "breached-by-wt1\n", "utf-8");
    assert.equal(worktree.inspectWorktreeChanges(wt1.path).dirty, true);
    assert.equal(worktree.inspectWorktreeChanges(wt2.path).dirty, false);

    // 宇宙 1 发出的认知脉冲瞬间穿透到宇宙 2 的侧线
    field.postPulse(
      "wt-siege",
      {
        actorId: "u1",
        actorLabel: "t1-probe",
        kind: "echo",
        anchor: "wall.txt:1",
        fact: "Direct rewrite broke checksum; seam must bypass header",
      },
      sharedRoot,
    );
    const u2Delta = field.buildSidelineDelta("wt-siege", "u2", field.emptySidelineCursor(), {
      storageRoot: sharedRoot,
    });
    assert.ok(u2Delta);
    assert.match(u2Delta.text, /Direct rewrite broke checksum/);

    worktree.removeTentacleWorktree(repoDir, wt1.path);
    worktree.removeTentacleWorktree(repoDir, wt2.path);
    assert.equal(existsSync(wt1.path), false);
    assert.equal(existsSync(wt2.path), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("extensions/field.ts 生命周期：普通会话零注入、接入后 tool_result 搭便车且保留 structuredContent、退出自动释放锁", async () => {
  const handlers = new Map<string, Array<(...args: any[]) => Promise<any>>>();
  const tools = new Map<string, any>();
  const piMock = {
    on(event: string, fn: (...args: any[]) => Promise<any>) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(fn);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    sendMessage() {},
  };

  await fieldExt(piMock);
  const fieldTool = tools.get("field");
  assert.ok(fieldTool);

  const ctx = (sid: string) => ({
    cwd: workDir,
    mode: "tui",
    sessionManager: { getSessionId: () => sid },
  });

  // 1. 未接入任何 field 的普通会话：before_agent_start 返回 undefined（零开销）
  const plainStart = await handlers.get("before_agent_start")![0](
    { systemPrompt: "BASE" },
    ctx("sess-plain"),
  );
  assert.equal(plainStart, undefined);

  // 2. 会话 A 开启并接入 field，会话 B 加入同一个 field
  await fieldTool.execute("c1", { action: "open", field: "ext-live", goal: "test sideline" }, null, null, ctx("sess-a"));
  await fieldTool.execute("c2", { action: "join", field: "ext-live", lens: "seam" }, null, null, ctx("sess-b"));

  // 会话 B 的 before_agent_start 注入 systemPrompt + snapshot
  const bStart = await handlers.get("before_agent_start")![0](
    { systemPrompt: "BASE" },
    ctx("sess-b"),
  );
  assert.ok(bStart?.systemPrompt.includes("DRIVE BY WORLD FEEDBACK"));
  assert.ok(bStart?.message?.content.includes("FIELD SNAPSHOT"));

  // 会话 A 抢占 frida 并发出一条脉冲
  const claimA = await fieldTool.execute(
    "c3",
    { action: "claim", resource: "frida@pixel7", purpose: "hook ssl" },
    null,
    null,
    ctx("sess-a"),
  );
  assert.match(claimA.content[0].text, /Claimed exclusive resource/);

  // 会话 B 尝试抢占同一 frida -> 收到 BUSY 提示而非报错炸掉
  const claimB = await fieldTool.execute(
    "c4",
    { action: "claim", resource: "frida@pixel7", purpose: "also hook" },
    null,
    null,
    ctx("sess-b"),
  );
  assert.match(claimB.content[0].text, /BUSY/);

  await fieldTool.execute(
    "c5",
    { action: "pulse", kind: "echo", anchor: "ssl.c:88", fact: "SSL_read hooked; plaintext starts with MAGIC" },
    null,
    null,
    ctx("sess-a"),
  );

  // 会话 B 执行普通 read 工具 -> tool_result 自动搭便车带回 [FIELD Δ] 且完整保留 structuredContent
  const tr = await handlers.get("tool_result")![0](
    {
      toolName: "read",
      input: { path: "app.ts" },
      content: [{ type: "text", text: "file body" }],
      structuredContent: { lines: 10 },
      isError: false,
    },
    ctx("sess-b"),
  );
  assert.ok(tr);
  assert.equal(tr.content.length, 2);
  assert.match(tr.content[1].text, /\[FIELD Δ/);
  assert.match(tr.content[1].text, /MAGIC/);
  assert.match(tr.content[1].text, /LOCK: frida@pixel7/);
  assert.deepEqual(tr.structuredContent, { lines: 10 });

  // 活跃队友仍在场时拒绝提前 close
  const earlyClose = await fieldTool.execute("c6", { action: "close", field: "ext-live" }, null, null, ctx("sess-a"));
  assert.match(earlyClose.content[0].text, /Cannot close field/);
  assert.equal(field.getFieldMeta("ext-live")?.status, "active");

  // 会话 A 关闭退出 -> 自动释放 frida 锁
  await handlers.get("session_shutdown")![0]({}, ctx("sess-a"));
  assert.equal(field.listResources("ext-live").length, 0);
});

test("spawn action=flux 端到端异步活体编排（worktree 隔离 + 共享侧线 + 单点 Board 归并）", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "pi-harness-spawn-live-"));
  const prevCwd = process.cwd();
  const prevPiBin = process.env.PI_BIN;
  try {
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@local"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "target.txt"), "sealed\n", "utf-8");
    execFileSync("git", ["add", "target.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

    // Fake pi executable: each tentacle emits a real pulse into the shared field;
    // t2-seam also mutates target.txt in its own worktree and emits a breach.
    const fakePi = join(repoDir, "fake-live-pi.mjs");
    const fieldMod = join(originalCwd, "core/field/index.ts");
    writeFileSync(
      fakePi,
      `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { postPulse, readPulses } from ${JSON.stringify(fieldMod)};
const fid = process.env.PI_FIELD_ID;
const root = process.env.PI_FIELD_ROOT;
const actor = process.env.PI_FIELD_ACTOR;
const actorId = process.env.PI_FIELD_ACTOR_ID;
const lens = process.env.PI_FIELD_LENS;
if (lens === "seam") {
  writeFileSync("target.txt", "breached\\n", "utf-8");
  postPulse(fid, { actorId, actorLabel: actor, lens, kind: "breach", anchor: "target.txt:1", fact: "Found seam bypass in worktree" }, root);
  console.log("seam breached");
} else {
  await new Promise(r => setTimeout(r, 80));
  const seen = readPulses(fid, undefined, root);
  postPulse(fid, { actorId, actorLabel: actor, lens, kind: "echo", fact: "Saw " + seen.length + " peer pulse(s); verified orthogonally" }, root);
  console.log("spine saw " + seen.length);
}
`,
      { encoding: "utf-8", mode: 0o755 },
    );

    process.env.PI_BIN = fakePi;
    // Dynamically import with isolated storage via runWithProjectRoot?
    // board/flux use getStorageRoot() which is memoized to workDir; keep repoDir as ctx.cwd
    // while using workDir's open topic & flux config.
    const board = await import("../core/board/index.ts");
    const flux = await import("../core/flux/index.ts");
    const spawnExt = (await import("../extensions/spawn.ts")).default;

    flux.setFluxConfig({ enabled: true, models: ["deepseek/deepseek-flash"], tentacles: 2, mode: "worktree" });
    board.openTopic("live-siege", "test live flux worktree");

    let spawnTool: any;
    await spawnExt({ registerTool(t: any) { spawnTool = t; } });
    assert.ok(spawnTool);

    const res = await spawnTool.execute(
      "sp1",
      {
        action: "flux",
        topic: "live-siege",
        question: "Find the seam in target.txt",
        lenses: ["spine", "seam"],
        mode: "worktree",
      },
      null,
      null,
      { cwd: repoDir, sessionManager: { getSessionId: () => "main-sess" } },
    );

    const text = res.content[0].text;
    assert.match(text, /Live Flux complete \(2 tentacles, worktree, 2 pulses, BREACH verified/);
    assert.match(text, /Found seam bypass in worktree/);
    assert.match(text, /Worktree changes/);

    // Main Board received ONE clean structured summary note
    const notes = board.readNotes("live-siege");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].author, "flux");
    assert.match(notes[0].content, /Breakthroughs/);
    assert.match(notes[0].content, /Found seam bypass in worktree/);

    // 零配置默认开启 + 自动开新 topic + 继承当前会话 provider/id 模型
    flux.clearProjectFluxConfig();
    const zeroCfgRes = await spawnTool.execute(
      "sp2",
      {
        action: "flux",
        topic: "auto-opened-hunt",
        question: "Zero-config natural language launch",
        tentacles: 2,
        mode: "shared",
      },
      null,
      null,
      {
        cwd: repoDir,
        model: { provider: "ollama", id: "deepseek-v4.1-flash:1017" },
        sessionManager: { getSessionId: () => "main-sess" },
      },
    );
    assert.match(zeroCfgRes.content[0].text, /Live Flux complete \(2 tentacles, shared/);
    assert.match(zeroCfgRes.content[0].text, /ollama\/deepseek-v4\.1-flash:1017/);
    assert.equal(board.readNotes("auto-opened-hunt").length, 1);
  } finally {
    process.chdir(prevCwd);
    if (prevPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = prevPiBin;
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("侧线 focusArea 迁移刷新 LIVE 且能捕捉同子目录重叠（修复单步致盲）", () => {
  field.openField("focus-shift", "track peer directory drift");
  field.updatePresence("focus-shift", {
    actorId: "a1",
    label: "t1-spine",
    lens: "spine",
    heading: "read src/core/a.ts",
    focusArea: "src/core",
    targets: ["src/core/a.ts"],
  });
  field.updatePresence("focus-shift", {
    actorId: "a2",
    label: "t2-seam",
    lens: "seam",
    heading: "read analysis/net/proto.py",
    focusArea: "analysis/net",
    targets: ["analysis/net/proto.py"],
  });

  let cursor = field.emptySidelineCursor();
  const d1 = field.buildSidelineDelta("focus-shift", "a1", cursor, {
    currentTargets: ["src/core/a.ts"],
  });
  assert.ok(d1);
  cursor = d1.nextCursor;

  // 同目录反复读写保持静默（抗噪）
  field.updatePresence("focus-shift", {
    actorId: "a2",
    label: "t2-seam",
    lens: "seam",
    heading: "read analysis/net/frame.py",
    focusArea: "analysis/net",
    targets: ["analysis/net/frame.py"],
  });
  assert.equal(
    field.buildSidelineDelta("focus-shift", "a1", cursor, { currentTargets: ["src/core/a.ts"] }),
    null,
  );

  // 队友迁移到新子目录 analysis/unpack/tools -> 必须触发 LIVE 刷新
  field.updatePresence("focus-shift", {
    actorId: "a2",
    label: "t2-seam",
    lens: "seam",
    heading: "write analysis/unpack/tools/reloc.py",
    focusArea: "analysis/unpack/tools",
    targets: ["analysis/unpack/tools/reloc.py"],
  });
  const dShift = field.buildSidelineDelta("focus-shift", "a1", cursor, {
    currentTargets: ["src/core/a.ts"],
  });
  assert.ok(dShift);
  assert.match(dShift.text, /LIVE:.*t2-seam.*reloc\.py/);
  cursor = dShift.nextCursor;

  // a1 切入同一子目录 analysis/unpack/tools 写不同文件 -> 触发子目录级 OVERLAP
  const dDirOverlap = field.buildSidelineDelta("focus-shift", "a1", cursor, {
    currentTargets: ["analysis/unpack/tools/dump.py"],
  });
  assert.ok(dDirOverlap);
  assert.equal(dDirOverlap.overlaps.length, 1);
  assert.equal(dDirOverlap.overlaps[0].target, "analysis/unpack/tools");
  assert.match(dDirOverlap.text, /OVERLAP:.*t2-seam.*analysis\/unpack\/tools/);
});

test("spawnAgent 活跃度看门狗：有场心跳的沉默进程保活，真正卡死进程按 idleTimeoutMs 终止", async () => {
  const scriptDir = mkdtempSync(join(tmpdir(), "pi-harness-watchdog-"));
  const prevPiBin = process.env.PI_BIN;
  try {
    const fieldMod = join(originalCwd, "core/field/index.ts");
    const storageRoot = join(workDir, ".pi-board");
    field.openField("watchdog-live", "verify activity heartbeat", { storageRoot });

    const board = await import("../core/board/index.ts");
    board.openTopic("watchdog-topic", "watchdog test");
    const { spawnAgent } = await import("../core/spawn/index.ts");
    const { loadProfile } = await import("../core/identity/index.ts");

    // 1. 进程在 750ms 内不输出 stdout，但每 120ms 刷新一次 field presence -> 必须突破 350ms idleTimeoutMs 正常退出
    const aliveScript = join(scriptDir, "heartbeat-pi.mjs");
    writeFileSync(
      aliveScript,
      `#!/usr/bin/env bun
import { updatePresence } from ${JSON.stringify(fieldMod)};
for (let i = 0; i < 6; i++) {
  updatePresence(process.env.PI_FIELD_ID, { actorId: process.env.PI_FIELD_ACTOR_ID, label: "alive", heading: "step " + i }, process.env.PI_FIELD_ROOT);
  await new Promise(r => setTimeout(r, 120));
}
console.log("heartbeat-survived");
`,
      { encoding: "utf-8", mode: 0o755 },
    );
    process.env.PI_BIN = aliveScript;
    const aliveRes = await spawnAgent({
      profile: loadProfile("tentacle"),
      topic: "watchdog-topic",
      task: "stay alive via field heartbeat",
      fieldId: "watchdog-live",
      actorId: "watchdog-live:alive",
      fieldStorageRoot: storageRoot,
      idleTimeoutMs: 350,
      env: {
        PI_FIELD_ID: "watchdog-live",
        PI_FIELD_ACTOR_ID: "watchdog-live:alive",
        PI_FIELD_ROOT: storageRoot,
      },
    });
    assert.equal(aliveRes.timedOut, false);
    assert.equal(aliveRes.exitCode, 0);
    assert.match(aliveRes.output, /heartbeat-survived/);
    assert.ok(field.latestFieldActivityMs("watchdog-live", "watchdog-live:alive", storageRoot) > 0);

    // 2. 进程完全静默无任何输出也无心跳 -> 触发 idleTimeoutMs 终止
    const hungScript = join(scriptDir, "hung-pi.mjs");
    writeFileSync(
      hungScript,
      `#!/usr/bin/env bun
await new Promise(r => setTimeout(r, 5000));
`,
      { encoding: "utf-8", mode: 0o755 },
    );
    process.env.PI_BIN = hungScript;
    const hungRes = await spawnAgent({
      profile: loadProfile("tentacle"),
      topic: "watchdog-topic",
      task: "hang silently",
      fieldId: "watchdog-live",
      actorId: "watchdog-live:hung",
      fieldStorageRoot: storageRoot,
      idleTimeoutMs: 250,
    });
    assert.equal(hungRes.timedOut, true);
  } finally {
    if (prevPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = prevPiBin;
    rmSync(scriptDir, { recursive: true, force: true });
  }
});

