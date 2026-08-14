import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// board/events 的存储根锚定 process.cwd()/.pi-board（core/storage 惰性初始化），
// 因此在动态 import 前 chdir 到临时目录即可完全隔离，不污染仓库。
let workDir: string;
let originalCwd: string;
let board: typeof import("../core/board/index.ts");

before(async () => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-board-test-"));
  process.chdir(workDir);
  board = await import("../core/board/index.ts");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

test("openTopic 创建 open 状态的 topic，重复 open 抛错", () => {
  const topic = board.openTopic("t-open", "verify open semantics");
  assert.equal(topic.id, "t-open");
  assert.equal(topic.goal, "verify open semantics");
  assert.equal(topic.status, "open");
  assert.throws(() => board.openTopic("t-open", "again"), /already exists/);
  for (const unsafeId of ["../escaped", "nested/topic", "..\\escaped", ""]) {
    assert.throws(
      () => board.openTopic(unsafeId, "must remain inside Board storage"),
      /one non-empty path segment/,
    );
  }
});

test("postNote 递增 seq 并持久化 tags/priority，readNotes 支持 since 增量", () => {
  board.openTopic("t-post", "verify post semantics");
  const n1 = board.postNote("t-post", "scout", "first finding");
  const n2 = board.postNote("t-post", "reviewer", "verdict", {
    tags: ["convergence"],
    priority: "critical",
  });
  assert.equal(n1.seq, 1);
  assert.equal(n2.seq, 2);

  const all = board.readNotes("t-post");
  assert.equal(all.length, 2);
  assert.deepEqual(all[1].tags, ["convergence"]);
  assert.equal(all[1].priority, "critical");

  const incremental = board.readNotes("t-post", 1);
  assert.equal(incremental.length, 1);
  assert.equal(incremental[0].seq, 2);

  assert.throws(() => board.postNote("t-missing", "x", "y"), /not found/);
});

test("多进程同时 post 保持唯一连续 seq 且 board.md 无临时文件冲突", { timeout: 20_000 }, async () => {
  const topic = "t-concurrent";
  const workers = 24;
  const goPath = join(workDir, "concurrent.go");
  const moduleUrl = new URL("../core/board/index.ts", import.meta.url).href;
  board.openTopic(topic, "verify process-safe Board writes");

  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    const wait = new Int32Array(new SharedArrayBuffer(4));
    process.chdir(process.env.BOARD_CWD);
    const board = await import(process.env.BOARD_MODULE);
    writeFileSync(process.env.BOARD_READY, "ready");
    while (!existsSync(process.env.BOARD_GO)) Atomics.wait(wait, 0, 0, 10);
    board.postNote(process.env.BOARD_TOPIC, process.env.BOARD_AUTHOR, process.env.BOARD_CONTENT);
  `;
  const children = Array.from({ length: workers }, (_, index) => {
    const readyPath = join(workDir, `concurrent-ready-${index}`);
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
          BOARD_CWD: workDir,
          BOARD_MODULE: moduleUrl,
          BOARD_READY: readyPath,
          BOARD_GO: goPath,
          BOARD_TOPIC: topic,
          BOARD_AUTHOR: `worker-${index}`,
          BOARD_CONTENT: `concurrent-note-${index}`,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    return {
      child,
      readyPath,
      exited: new Promise<{ code: number | null; stderr: string }>(resolve => {
        child.on("exit", code => resolve({ code, stderr }));
      }),
    };
  });

  const readyDeadline = Date.now() + 10_000;
  while (!children.every(({ readyPath }) => existsSync(readyPath))) {
    if (Date.now() >= readyDeadline) {
      for (const { child } of children) child.kill();
      assert.fail("concurrent Board workers did not reach the start barrier");
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  writeFileSync(goPath, "go");
  const exits = await Promise.all(children.map(({ exited }) => exited));
  assert.deepEqual(
    exits.filter(({ code }) => code !== 0),
    [],
    exits.map(({ code, stderr }, index) => `worker-${index}: code=${code} ${stderr}`).join("\n"),
  );

  const notes = board.readNotes(topic);
  assert.equal(notes.length, workers);
  assert.deepEqual(notes.map(note => note.seq), Array.from({ length: workers }, (_, index) => index + 1));
  assert.equal(new Set(notes.map(note => note.seq)).size, workers);
  assert.deepEqual(
    new Set(notes.map(note => note.content)),
    new Set(Array.from({ length: workers }, (_, index) => `concurrent-note-${index}`)),
  );

  const topicsPath = join(workDir, ".pi-board", "topics");
  const boardMd = readFileSync(join(topicsPath, `${topic}.board.md`), "utf-8");
  for (let index = 0; index < workers; index += 1) {
    assert.match(boardMd, new RegExp(`concurrent-note-${index}(?:\\n|$)`));
  }
  assert.deepEqual(
    readdirSync(topicsPath).filter(file => file.startsWith(`${topic}.board.md.`)),
    [],
  );
});

test("closeTopic 归档完整 notes 并产出 summary/decisions", () => {
  board.openTopic("t-close", "verify close semantics");
  for (let i = 1; i <= 8; i++) {
    board.postNote("t-close", "worker", `finding-${i}`, i === 8 ? { priority: "critical" } : undefined);
  }

  const { summary, decisions } = board.closeTopic("t-close");
  assert.match(summary, /Summary: t-close/);
  assert.match(summary, /finding-1/);
  assert.match(summary, /finding-4/);
  assert.match(summary, /finding-8/);
  assert.match(summary, /Complete Activity/);
  assert.match(decisions, /finding-8/);

  const archiveDir = join(workDir, ".pi-board", "topics", "archive");
  assert.ok(existsSync(join(archiveDir, "t-close.jsonl")), "jsonl 应移入 archive");
  assert.ok(existsSync(join(archiveDir, "t-close.summary.md")));
  assert.ok(existsSync(join(archiveDir, "t-close.decisions.md")));
  assert.ok(!existsSync(join(workDir, ".pi-board", "topics", "t-close.jsonl")));

  const archivedMeta = readFileSync(join(archiveDir, "t-close.jsonl"), "utf-8").split("\n")[0];
  assert.match(archivedMeta, /"status":"closed"/);

  const listed = board.listTopics().find(t => t.id === "t-close");
  assert.ok(listed, "listTopics 应包含归档 topic");
  assert.equal(listed.status, "closed");
  assert.equal(listed.noteCount, 8);

  const openIds = board.listOpenTopics().map(topic => topic.id);
  assert.ok(openIds.includes("t-open"));
  assert.ok(openIds.includes("t-post"));
  assert.ok(!openIds.includes("t-close"), "listOpenTopics 不读取 archive");

  // 已归档后原路径不存在，再次 close 报 not found
  assert.throws(() => board.closeTopic("t-close"), /not found/);
  assert.throws(
    () => board.openTopic("t-close", "must not reset an archived cursor"),
    /already exists in archive/,
  );
});

test("旧版本复用 topic ID 造成归档冲突时 fail-loud 且不覆盖任何历史", () => {
  const topicId = "t-legacy-reused-id";
  board.openTopic(topicId, "first archived incarnation");
  board.postNote(topicId, "legacy", "first-incarnation-note");
  board.closeTopic(topicId);

  const topicsPath = join(workDir, ".pi-board", "topics");
  const archiveDir = join(topicsPath, "archive");
  const archivedArtifacts = [
    `${topicId}.jsonl`,
    `${topicId}.board.md`,
    `${topicId}.summary.md`,
    `${topicId}.decisions.md`,
  ];
  const before = new Map(
    archivedArtifacts.map(file => [file, readFileSync(join(archiveDir, file), "utf-8")]),
  );

  // Legacy releases allowed opening the same ID after close. Recreate that
  // persisted shape directly, then prove the new close path changes neither
  // the first archive nor the still-active second incarnation.
  const activeMeta = {
    id: topicId,
    goal: "second active incarnation",
    status: "open",
    createdAt: Date.now(),
  };
  const activeJsonl = [
    `#META#${JSON.stringify(activeMeta)}`,
    JSON.stringify({
      seq: 1,
      author: "legacy",
      timestamp: Date.now(),
      content: "second-incarnation-note",
    }),
    "",
  ].join("\n");
  const activeBoard = "legacy active board fixture\n";
  writeFileSync(join(topicsPath, `${topicId}.jsonl`), activeJsonl, "utf-8");
  writeFileSync(join(topicsPath, `${topicId}.board.md`), activeBoard, "utf-8");

  assert.throws(
    () => board.closeTopic(topicId),
    /Archive collision.*active topic was preserved/,
  );
  for (const [file, content] of before) {
    assert.equal(readFileSync(join(archiveDir, file), "utf-8"), content, `${file} was overwritten`);
  }
  assert.equal(readFileSync(join(topicsPath, `${topicId}.jsonl`), "utf-8"), activeJsonl);
  assert.equal(readFileSync(join(topicsPath, `${topicId}.board.md`), "utf-8"), activeBoard);
  assert.equal(board.readNotes(topicId)[0].content, "second-incarnation-note");
});
