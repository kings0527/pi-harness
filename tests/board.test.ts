import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// board/events 的存储根锚定 process.cwd()/.pi-board（core/storage 惰性初始化），
// 因此在动态 import 前 chdir 到临时目录即可完全隔离，不污染仓库。
let workDir: string;
let board: typeof import("../core/board/index.ts");

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-board-test-"));
  process.chdir(workDir);
  board = await import("../core/board/index.ts");
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test("openTopic 创建 open 状态的 topic，重复 open 抛错", () => {
  const topic = board.openTopic("t-open", "verify open semantics");
  assert.equal(topic.id, "t-open");
  assert.equal(topic.goal, "verify open semantics");
  assert.equal(topic.status, "open");
  assert.throws(() => board.openTopic("t-open", "again"), /already exists/);
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

test("closeTopic 归档 jsonl 并产出 summary/decisions，重复 close 抛错", () => {
  board.openTopic("t-close", "verify close semantics");
  board.postNote("t-close", "worker", "conclusion", { priority: "critical" });

  const { summary, decisions } = board.closeTopic("t-close");
  assert.match(summary, /Summary: t-close/);
  assert.match(decisions, /conclusion/);

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
  assert.equal(listed.noteCount, 1);

  // 已归档后原路径不存在，再次 close 报 not found
  assert.throws(() => board.closeTopic("t-close"), /not found/);
});
