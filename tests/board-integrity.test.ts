// ADR-0020: Board integrity tests.
// Core contract:
// - Live topic JSONL with a seq gap/rollback → readNotes/postNote fail loud.
// - Archived topic whose summary cites notes beyond the JSONL max seq
//   (Git-conflict tail truncation, notes #31–#35 incident) → readArchivedTopic
//   and listTopics fail loud.
// - Intact archive → reads pass; goal prose with unrelated #numbers → no false alarm.
// - Legacy archive without summary.md → degrades to seq-continuity only, no false alarm.
// - boardTrackedPaths parses `git ls-files` output.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// board/events 的存储根锚定 process.cwd()/.pi-board（core/storage 惰性初始化），
// 因此在动态 import 前 chdir 到临时目录即可完全隔离，不污染仓库。
let workDir: string;
let originalCwd: string;
let board: typeof import("../core/board/index.ts");
let integrity: typeof import("../core/board/integrity.ts");
let gitTracking: typeof import("../core/board/git-tracking.ts");

before(async () => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-board-integrity-test-"));
  process.chdir(workDir);
  board = await import("../core/board/index.ts");
  integrity = await import("../core/board/integrity.ts");
  gitTracking = await import("../core/board/git-tracking.ts");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
});

function archiveJsonlPath(topicId: string): string {
  return integrity.archivedTopicPaths(topicId).jsonl;
}

function archiveSummaryPath(topicId: string): string {
  return integrity.archivedTopicPaths(topicId).summary;
}

/** Rewrite the archive JSONL so it only keeps notes with seq <= keepSeq. */
function truncateArchiveTail(topicId: string, keepSeq: number): void {
  const path = archiveJsonlPath(topicId);
  const lines = readFileSync(path, "utf-8").split("\n").filter(l => l.trim());
  const kept = lines.filter(line => {
    if (line.startsWith("#META#")) return true;
    return (JSON.parse(line) as { seq: number }).seq <= keepSeq;
  });
  writeFileSync(path, kept.join("\n") + "\n", "utf-8");
}

/** Remove a deliberately damaged archived topic so later tests stay clean. */
function removeArchivedTopic(topicId: string): void {
  for (const p of [
    integrity.archivedTopicPaths(topicId).jsonl,
    integrity.archivedTopicPaths(topicId).summary,
    join(workDir, ".pi-board", "topics", "archive", `${topicId}.board.md`),
    join(workDir, ".pi-board", "topics", "archive", `${topicId}.decisions.md`),
  ]) {
    rmSync(p, { force: true });
  }
}

test("活 topic seq 回滚时 readNotes/postNote fail-loud", () => {
  board.openTopic("t-live-rollback", "verify live rollback detection");
  board.postNote("t-live-rollback", "agent", "note-1");
  board.postNote("t-live-rollback", "agent", "note-2");
  board.postNote("t-live-rollback", "agent", "note-3");
  assert.equal(board.readNotes("t-live-rollback").length, 3);

  // Simulate an external rewrite that drops a MIDDLE line (Git conflict
  // rollback). NOTE: truncating the tail of a live topic is invisible — a live
  // file has no close-time summary as a cross-check witness; the guard covers
  // what is detectable (seq gaps/rollbacks) and the archived tail-truncation
  // case (next test).
  const path = join(workDir, ".pi-board", "topics", "t-live-rollback.jsonl");
  const lines = readFileSync(path, "utf-8").split("\n").filter(l => l.trim());
  const droppedMiddle = [lines[0], ...lines.slice(2)]; // keeps META + #1 + #3
  writeFileSync(path, droppedMiddle.join("\n") + "\n", "utf-8");

  assert.throws(() => board.readNotes("t-live-rollback"), /corrupted.*rollback|corrupted/);
  // Writes must also fail: appending to a corrupted file would forge seq 3 again.
  assert.throws(() => board.postNote("t-live-rollback", "agent", "forged"), /corrupted/);

  // Clean up the deliberately corrupted live topic so later tests' listTopics
  // scans do not trip over it.
  rmSync(join(workDir, ".pi-board", "topics", "t-live-rollback.jsonl"), { force: true });
  rmSync(join(workDir, ".pi-board", "topics", "t-live-rollback.board.md"), { force: true });
});

test("归档尾部截断被 summary 对端校验抓出（#31–#35 事故）", () => {
  board.openTopic("t-tail-truncated", "verify tail truncation detection");
  for (let i = 1; i <= 8; i += 1) {
    board.postNote("t-tail-truncated", "worker", `finding-${i}`);
  }
  board.closeTopic("t-tail-truncated");

  // Summary still cites #8; JSONL now ends at #5 — a valid prefix, invisible
  // to seq-continuity alone.
  const summary = readFileSync(archiveSummaryPath("t-tail-truncated"), "utf-8");
  assert.match(summary, /- \[#8\]/);
  truncateArchiveTail("t-tail-truncated", 5);

  assert.throws(
    () => board.readArchivedTopic("t-tail-truncated"),
    /finalSeq=8 vs JSONL maxSeq=#5 mismatch/,
  );
  assert.throws(() => board.listTopics(), /finalSeq=8 vs JSONL maxSeq=#5 mismatch/);

  // The audit report names the exact gap.
  const report = integrity.auditArchivedTopic("t-tail-truncated");
  assert.equal(report.maxSeq, 5);
  assert.equal(report.witnessKind, "v1");
  assert.match(report.issues.join("; "), /finalSeq=8 vs JSONL maxSeq=#5 mismatch/);

  // Clean up the deliberately corrupted archive so later tests' listTopics
  // scans do not trip over it.
  removeArchivedTopic("t-tail-truncated");
});

test("完好归档通过全部校验，goal 文本里的 #数字 不误报", () => {
  board.openTopic("t-intact", "verify goal prose with #419 does not false-alarm");
  board.postNote("t-intact", "agent", "first");
  board.postNote("t-intact", "agent", "second", { priority: "critical" });
  board.closeTopic("t-intact");

  const { topic, notes } = board.readArchivedTopic("t-intact");
  assert.equal(topic.status, "closed");
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map(n => n.seq), [1, 2]);
  assert.equal(integrity.auditArchivedTopic("t-intact").issues.length, 0);
  const listed = board.listTopics().find(t => t.id === "t-intact");
  assert.ok(listed);
  assert.equal(listed.noteCount, 2);
});

test("legacy 归档无 summary 时降级为仅 seq 连续性，不误报", () => {
  // Build a legacy archive by hand: closed META + continuous seq, no summary.md.
  const archiveDir = join(workDir, ".pi-board", "topics", "archive");
  const meta = {
    id: "t-legacy-no-summary",
    goal: "legacy shape",
    status: "closed",
    createdAt: Date.now(),
    closedAt: Date.now(),
  };
  const lines = [
    `#META#${JSON.stringify(meta)}`,
    JSON.stringify({ seq: 1, author: "agent", timestamp: Date.now(), content: "only-note" }),
    "",
  ];
  writeFileSync(join(archiveDir, "t-legacy-no-summary.jsonl"), lines.join("\n"), "utf-8");
  assert.ok(!existsSync(archiveSummaryPath("t-legacy-no-summary")));

  const { topic, notes } = board.readArchivedTopic("t-legacy-no-summary");
  assert.equal(topic.id, "t-legacy-no-summary");
  assert.equal(notes.length, 1);
  assert.equal(integrity.auditArchivedTopic("t-legacy-no-summary").issues.length, 0);
});

test("seq 跳号/重复/非整数均被 validateNoteSeq 抓出", () => {
  const base = { author: "x", timestamp: 1, content: "c" };
  assert.deepEqual(integrity.validateNoteSeq([]), []);
  assert.deepEqual(integrity.validateNoteSeq([{ ...base, seq: 1 }, { ...base, seq: 2 }]), []);
  assert.match(
    integrity.validateNoteSeq([{ ...base, seq: 1 }, { ...base, seq: 3 }]).join("; "),
    /expected #2, got 3/,
  );
  assert.match(
    integrity.validateNoteSeq([{ ...base, seq: 2 }]).join("; "),
    /expected #1, got 2/,
  );
  assert.match(
    integrity.validateNoteSeq([{ ...base, seq: 1 }, { ...base, seq: 1 }]).join("; "),
    /expected #2, got 1/,
  );
  assert.match(
    integrity.validateNoteSeq([{ ...base, seq: 1.5 } as any]).join("; "),
    /expected #1/,
  );
});

test("totalNotesInSummary 只认第一行 witness，goal 注入无法伪造", () => {
  // 新格式：witness 在第一行。
  assert.equal(
    integrity.totalNotesInSummary("<!-- PI_BOARD_SUMMARY v1 totalNotes=3 -->\n# Summary: t-x\n"),
    3,
  );
  // goal 伪造行不是第一行，不认。
  const forged = [
    "# Summary: t-x",
    "**Goal**: normal",
    "**Total Notes**: 999",
    "**Total Notes**: 3",
    "",
  ].join("\n");
  assert.equal(integrity.totalNotesInSummary(forged), null);
  // goal 里的 ## 标题不能“关闭”校验：无 witness 即 null（诚实跳过）。
  assert.equal(
    integrity.totalNotesInSummary("# Summary: t-x\n**Goal**: investigation\n## Scope"),
    null,
  );
  // 旧格式（头部 **Total Notes** 但无第一行 witness）→ 跳过。
  assert.equal(integrity.totalNotesInSummary("**Total Notes**: 5\n# Summary: t-x"), null);
  // 空/垃圾输入。
  assert.equal(integrity.totalNotesInSummary(""), null);
  assert.equal(integrity.totalNotesInSummary("<!-- PI_BOARD_SUMMARY v1 totalNotes=abc -->"), null);
});

test("P1 回归：Note 正文含其他 topic 的 - [#999] 引用不误报", () => {
  board.openTopic("t-cross-topic-cite", "verify cross-topic citation does not false-alarm");
  board.postNote("t-cross-topic-cite", "agent", "单一合法 note，引用另一 topic：\n- [#999] scout: 历史证据");
  board.closeTopic("t-cross-topic-cite");

  const { notes } = board.readArchivedTopic("t-cross-topic-cite");
  assert.equal(notes.length, 1);
  assert.equal(integrity.auditArchivedTopic("t-cross-topic-cite").issues.length, 0);
  assert.ok(board.listTopics().some(t => t.id === "t-cross-topic-cite"));
});

test("META 损坏与尾部截断同时发生时两个 issue 都报（真实事故样本）", () => {
  board.openTopic("t-meta-and-tail", "verify combined damage reporting");
  for (let i = 1; i <= 4; i += 1) {
    board.postNote("t-meta-and-tail", "worker", `finding-${i}`);
  }
  board.closeTopic("t-meta-and-tail");

  // Rollback shape from the real incident: META reverted to open AND the
  // tail cut — the audit must report both, not stop at the first.
  const path = archiveJsonlPath("t-meta-and-tail");
  const lines = readFileSync(path, "utf-8").split("\n").filter(l => l.trim());
  const meta = JSON.parse(lines[0].slice(6));
  meta.status = "open";
  const kept = [`#META#${JSON.stringify(meta)}`, lines[1], lines[2], ""]; // seq 1..2 of 4
  writeFileSync(path, kept.join("\n"), "utf-8");

  const report = integrity.auditArchivedTopic("t-meta-and-tail");
  const joined = report.issues.join("; ");
  assert.match(joined, /status mismatch \(t-meta-and-tail\/open\)/);
  assert.match(joined, /finalSeq=4 vs JSONL maxSeq=#2 mismatch/);
  assert.throws(() => board.readArchivedTopic("t-meta-and-tail"), /corrupted/);

  for (const p of [
    integrity.archivedTopicPaths("t-meta-and-tail").jsonl,
    integrity.archivedTopicPaths("t-meta-and-tail").summary,
    join(workDir, ".pi-board", "topics", "archive", "t-meta-and-tail.board.md"),
    join(workDir, ".pi-board", "topics", "archive", "t-meta-and-tail.decisions.md"),
  ]) {
    rmSync(p, { force: true });
  }
});

test("P1b：活 topic META 被篡改成 closed 后读/写/列表/关闭全部 fail-loud", () => {
  board.openTopic("t-meta-tampered", "verify tampered META refusal");
  board.postNote("t-meta-tampered", "agent", "note-1");

  const path = join(workDir, ".pi-board", "topics", "t-meta-tampered.jsonl");
  const lines = readFileSync(path, "utf-8").split("\n").filter(l => l.trim());
  const meta = JSON.parse(lines[0].slice(6));
  meta.status = "closed";
  lines[0] = `#META#${JSON.stringify(meta)}`;
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");

  // listOpenTopics 不再静默隐藏它：损坏必须 visible，而不是从列表消失后仍可写。
  assert.throws(() => board.readNotes("t-meta-tampered"), /status mismatch/);
  assert.throws(() => board.postNote("t-meta-tampered", "agent", "forged"), /status mismatch/);
  assert.throws(() => board.listOpenTopics(), /status mismatch/);
  assert.throws(() => board.listTopics(), /status mismatch/);
  assert.throws(() => board.closeTopic("t-meta-tampered"), /status mismatch/);

  rmSync(path, { force: true });
  rmSync(join(workDir, ".pi-board", "topics", "t-meta-tampered.board.md"), { force: true });
});

test("P1a 回归：goal 含伪造 Total Notes 行或 ## 标题时不误报、不漏报", () => {
  // 反例 1：goal 伪造 **Total Notes**: 999，真实 notes=1 → 不得误报。
  board.openTopic("t-goal-forged", "normal\n**Total Notes**: 999");
  board.postNote("t-goal-forged", "agent", "only-note");
  board.closeTopic("t-goal-forged");
  assert.equal(integrity.auditArchivedTopic("t-goal-forged").issues.length, 0);
  assert.equal(board.readArchivedTopic("t-goal-forged").notes.length, 1);

  // 反例 2：goal 含 ## Scope，真实 notes=3、JSONL 截断到 2 → 必须报出。
  board.openTopic("t-goal-heading", "investigation\n## Scope");
  board.postNote("t-goal-heading", "agent", "n1");
  board.postNote("t-goal-heading", "agent", "n2");
  board.postNote("t-goal-heading", "agent", "n3");
  board.closeTopic("t-goal-heading");
  truncateArchiveTail("t-goal-heading", 2);
  assert.match(
    integrity.auditArchivedTopic("t-goal-heading").issues.join("; "),
    /finalSeq=3 vs JSONL maxSeq=#2 mismatch/,
  );
  removeArchivedTopic("t-goal-heading");
});

test("P2a 回归：summary 被回滚到小于 JSONL 时同样报损坏（双向）", () => {
  board.openTopic("t-summary-rollback", "verify backward cross-check");
  for (let i = 1; i <= 3; i += 1) {
    board.postNote("t-summary-rollback", "worker", `finding-${i}`);
  }
  board.closeTopic("t-summary-rollback");

  const summaryPath = archiveSummaryPath("t-summary-rollback");
  writeFileSync(
    summaryPath,
    readFileSync(summaryPath, "utf-8").replace(/totalNotes=\d+/, "totalNotes=2"),
    "utf-8",
  );

  const report = integrity.auditArchivedTopic("t-summary-rollback");
  assert.match(report.issues.join("; "), /witness=2 disagrees \(finalSeq=3, JSONL maxSeq=#3\)/);
  assert.throws(() => board.readArchivedTopic("t-summary-rollback"), /corrupted/);
  removeArchivedTopic("t-summary-rollback");
});

test("P1 回归：v1 归档 witness 被删不得伪装 legacy", () => {
  board.openTopic("t-witness-deleted", "verify witness deletion is detected");
  for (let i = 1; i <= 3; i += 1) {
    board.postNote("t-witness-deleted", "worker", `finding-${i}`);
  }
  board.closeTopic("t-witness-deleted");

  // Attack: strip the first-line witness, then truncate the JSONL tail.
  const summaryPath = archiveSummaryPath("t-witness-deleted");
  const stripped = readFileSync(summaryPath, "utf-8").split("\n").slice(1).join("\n");
  writeFileSync(summaryPath, stripped, "utf-8");
  truncateArchiveTail("t-witness-deleted", 2);

  const report = integrity.auditArchivedTopic("t-witness-deleted");
  assert.equal(report.witnessKind, "v1", "META integrityVersion=1 keeps it v1 even without the witness");
  assert.match(report.issues.join("; "), /summary witness line missing or malformed/);
  assert.throws(() => board.readArchivedTopic("t-witness-deleted"), /witness/);
  removeArchivedTopic("t-witness-deleted");
});

test("legacy 归档结构化解析：goal 含伪造行仍取 canonical Total Notes", () => {
  // Hand-build a legacy archive: META without integrityVersion, old-format
  // summary, and a hostile goal containing both forged attacks.
  const topicId = "t-legacy-hostile-goal";
  const goal = "normal\n**Total Notes**: 999\n## Scope";
  const archiveDir = join(workDir, ".pi-board", "topics", "archive");
  const meta = {
    id: topicId,
    goal,
    status: "closed",
    createdAt: Date.now(),
    closedAt: Date.now(),
  };
  const jsonl = [
    `#META#${JSON.stringify(meta)}`,
    ...[1, 2, 3].map(seq =>
      JSON.stringify({ seq, author: "agent", timestamp: Date.now(), content: `n${seq}` }),
    ),
    "",
  ].join("\n");
  writeFileSync(join(archiveDir, `${topicId}.jsonl`), jsonl, "utf-8");

  const legacySummary = [
    `# Summary: ${topicId}`,
    "",
    `**Goal**: ${goal}`,
    `**Duration**: ${new Date(meta.createdAt).toISOString()} → ${new Date(meta.closedAt).toISOString()}`,
    "**Total Notes**: 3",
    "**Participants**: agent",
    "",
    "### Complete Activity",
    "- [#1] agent: n1",
    "- [#2] agent: n2",
    "- [#3] agent: n3",
    "",
  ].join("\n");
  writeFileSync(join(archiveDir, `${topicId}.summary.md`), legacySummary, "utf-8");

  // Intact legacy archive parses the canonical 3, not the forged 999.
  let report = integrity.auditArchivedTopic(topicId);
  assert.equal(report.witnessKind, "legacy-structured");
  assert.equal(report.issues.length, 0);
  assert.equal(integrity.legacyTotalNotes(legacySummary, meta as any), 3);

  // Truncate the JSONL tail → the structured witness still catches it.
  truncateArchiveTail(topicId, 2);
  report = integrity.auditArchivedTopic(topicId);
  assert.match(report.issues.join("; "), /Total Notes=3 but JSONL max seq=#2: tail notes lost/);
  removeArchivedTopic(topicId);
});

test("字段守卫：缺字段 Note 与 META 均被拒绝，postNote 不追加垃圾", () => {
  // META missing goal/createdAt → refused on every path.
  const badMetaPath = join(workDir, ".pi-board", "topics", "t-bad-meta.jsonl");
  writeFileSync(
    badMetaPath,
    `#META#${JSON.stringify({ id: "t-bad-meta", status: "open" })}\n`,
    "utf-8",
  );
  assert.throws(() => board.readNotes("t-bad-meta"), /META shape invalid/);
  assert.throws(() => board.postNote("t-bad-meta", "agent", "x"), /META shape invalid/);
  assert.throws(() => board.listOpenTopics(), /META shape invalid/);
  rmSync(badMetaPath, { force: true });

  // Note reduced to {seq:1} → refused, nothing appended, no render crash.
  const badNotePath = join(workDir, ".pi-board", "topics", "t-bad-note.jsonl");
  writeFileSync(
    badNotePath,
    [
      `#META#${JSON.stringify({
        id: "t-bad-note",
        goal: "guard",
        status: "open",
        createdAt: Date.now(),
      })}`,
      JSON.stringify({ seq: 1 }),
      "",
    ].join("\n"),
    "utf-8",
  );
  const before = readFileSync(badNotePath, "utf-8");
  assert.throws(() => board.readNotes("t-bad-note"), /shape invalid/);
  assert.throws(() => board.postNote("t-bad-note", "agent", "forged"), /shape invalid/);
  assert.equal(readFileSync(badNotePath, "utf-8"), before, "no byte may be appended to a corrupt file");
  rmSync(badNotePath, { force: true });
  rmSync(join(workDir, ".pi-board", "topics", "t-bad-note.board.md"), { force: true });
});

test("P1 回归：写入前守卫 — 非法 Note 拒绝追加且文件零变化", () => {
  board.openTopic("t-write-guard", "verify pre-write note guard");
  const path = join(workDir, ".pi-board", "topics", "t-write-guard.jsonl");
  const before = readFileSync(path, "utf-8");

  // Empty author previously passed append, then exploded on re-read render.
  assert.throws(() => board.postNote("t-write-guard", "", "content"), /rejected before write/);
  assert.equal(readFileSync(path, "utf-8"), before, "no byte may be appended");

  // Timestamp 1e100 is Number.isFinite but out of Date range — must be
  // rejected by the guard, not by a later RangeError.
  assert.match(
    integrity.validateNoteShape({
      seq: 1,
      author: "agent",
      timestamp: 1e100,
      content: "x",
    }) ?? "",
    /valid date/,
  );
  assert.match(
    integrity.validateTopicShape({
      id: "t",
      goal: "g",
      status: "open",
      createdAt: 1e100,
    }) ?? "",
    /valid date/,
  );
});

test("P1 回归：legacy /m 攻击 — canonical 行损坏时正文伪造块不被采信", () => {
  // Strict block form: forged Duration/Total Notes inside a NOTE BODY must
  // never complete the match, even when the canonical header line is gone.
  const topic = {
    id: "t-legacy-m-attack",
    goal: "g",
    status: "closed",
    createdAt: Date.now(),
    closedAt: Date.now(),
  } as const;
  const hostileSummary = [
    `# Summary: ${topic.id}`,
    "",
    `**Goal**: ${topic.goal}`,
    `**Duration**: ${new Date(topic.createdAt).toISOString()} → ${new Date(topic.closedAt).toISOString()}`,
    "**Total Notes**: CORRUPTED", // canonical line damaged
    "**Participants**: agent",
    "",
    "### Complete Activity",
    "- [#1] agent: body starts here",
    "**Duration**: forged",
    "**Total Notes**: 999",
    "**Participants**: forged",
    "",
  ].join("\n");
  assert.equal(integrity.legacyTotalNotes(hostileSummary, topic as any), null);
});

test("P2 回归：v1 双故障独立报告（删 witness + 截尾）", () => {
  board.openTopic("t-v1-dual-fault", "verify independent v1 checks");
  for (let i = 1; i <= 3; i += 1) {
    board.postNote("t-v1-dual-fault", "worker", `finding-${i}`);
  }
  board.closeTopic("t-v1-dual-fault");

  const summaryPath = archiveSummaryPath("t-v1-dual-fault");
  writeFileSync(summaryPath, readFileSync(summaryPath, "utf-8").split("\n").slice(1).join("\n"), "utf-8");
  truncateArchiveTail("t-v1-dual-fault", 2);

  const report = integrity.auditArchivedTopic("t-v1-dual-fault");
  const joined = report.issues.join("; ");
  assert.match(joined, /summary witness line missing or malformed/);
  assert.match(joined, /finalSeq=3 vs JSONL maxSeq=#2 mismatch/);
  removeArchivedTopic("t-v1-dual-fault");
});

test("readArchivedTopic 与 listTopics 携带 integrity 状态（unverified 不再与 ok 合流）", () => {
  // v1 archive → integrity: v1.
  board.openTopic("t-integrity-v1", "v1 state");
  board.postNote("t-integrity-v1", "agent", "n1");
  board.closeTopic("t-integrity-v1");
  assert.equal(board.readArchivedTopic("t-integrity-v1").integrity, "v1");
  assert.equal(board.listTopics().find(t => t.id === "t-integrity-v1")?.integrity, "v1");

  // Legacy archive with no summary → integrity: unverified, still readable.
  const legacyMeta = {
    id: "t-integrity-unverified",
    goal: "legacy",
    status: "closed",
    createdAt: Date.now(),
    closedAt: Date.now(),
  };
  const archiveDir = join(workDir, ".pi-board", "topics", "archive");
  writeFileSync(
    join(archiveDir, "t-integrity-unverified.jsonl"),
    `#META#${JSON.stringify(legacyMeta)}\n${JSON.stringify({ seq: 1, author: "a", timestamp: Date.now(), content: "x" })}\n`,
    "utf-8",
  );
  assert.equal(board.readArchivedTopic("t-integrity-unverified").integrity, "unverified");
  assert.equal(
    board.listTopics().find(t => t.id === "t-integrity-unverified")?.integrity,
    "unverified",
  );
});

test("boardTrackedPaths 解析 git ls-files 输出", () => {
  const out = [
    ".pi-board/events.jsonl",
    ".pi-board/context-snapshots/x.txt",
    "src/main.ts",
    ".pi-board",
    "",
    "  .pi-board/topics/archive/t.jsonl  ",
  ].join("\n");
  assert.deepEqual(gitTracking.boardTrackedPaths(out), [
    ".pi-board/events.jsonl",
    ".pi-board/context-snapshots/x.txt",
    ".pi-board",
    ".pi-board/topics/archive/t.jsonl",
  ]);
  assert.deepEqual(gitTracking.boardTrackedPaths("src/main.ts\n.gitignore\n"), []);
  assert.deepEqual(gitTracking.boardTrackedPaths(""), []);
});
