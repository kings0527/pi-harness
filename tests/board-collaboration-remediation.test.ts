import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cwd: string;
let originalCwd: string;
let board: typeof import("../core/board/index.ts");

const actorA = { id: "actor-a", label: "A" };
const actorB = { id: "actor-b", label: "B" };

before(async () => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "pi-harness-board-remediation-"));
  process.chdir(cwd);
  board = await import("../core/board/index.ts");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
});

test("P1: structured actors and references are append-only and target-validated", () => {
  board.openTopic("claims", "claim graph", { actor: actorA });
  const claim = board.postNote("claims", "A", "material assertion", {
    actor: actorA, kind: "claim", material: true,
  });
  const verify = board.postNote("claims", "B", "independent proof", {
    actor: actorB, kind: "verification", targets: [{ topic: "claims", seq: claim.seq }],
  });
  assert.equal(claim.actor?.id, "actor-a");
  assert.equal(verify.targets?.[0]?.seq, claim.seq);
  const before = readFileSync(join(cwd, ".pi-board", "topics", "claims.jsonl"), "utf-8");
  assert.throws(() => board.postNote("claims", "B", "bad", {
    actor: actorB, kind: "verification", targets: [{ topic: "claims", seq: 99 }],
  }), /does not exist/);
  assert.equal(readFileSync(join(cwd, ".pi-board", "topics", "claims.jsonl"), "utf-8"), before);
  assert.throws(() => board.postNote("claims", "B", "wrong kind", {
    actor: actorB, kind: "verification", targets: [{ topic: "claims", seq: verify.seq }],
  }), /target must be claim/);
});

test("P1: material claims require structured convergence and explicit resolution", () => {
  assert.throws(() => board.closeTopic("claims", { actor: actorA }), /no structured convergence verdict/);
  board.postNote("claims", "A", "bounded result", {
    actor: actorA,
    kind: "convergence",
    verdict: "claim independently verified",
  });
  assert.equal(board.assessCloseReadiness("claims").ready, true);
  board.closeTopic("claims", { actor: actorA });
  const archived = board.readArchivedTopic("claims");
  assert.equal(archived.topic.closedBy?.id, actorA.id);
  assert.equal(archived.integrity, "v1");
});

test("P1: new actor-created topic cannot bypass the close graph with a legacy convergence tag", () => {
  board.openTopic("created-but-unstructured", "must use a verdict", { actor: actorA });
  board.postNote("created-but-unstructured", "A", "pretend convergence", { tags: ["convergence"] });
  assert.throws(
    () => board.closeTopic("created-but-unstructured", { actor: actorA }),
    /no structured convergence verdict/,
  );
});

test("P1: legacy free-form notes remain closable through the existing convergence tag", () => {
  board.openTopic("legacy-close", "legacy topic");
  board.postNote("legacy-close", "legacy-agent", "old note", { tags: ["convergence"] });
  assert.doesNotThrow(() => board.closeTopic("legacy-close"));
});

test("P1: an unresolved material challenge blocks close until the verdict explicitly accepts it", () => {
  board.openTopic("challenge-gate", "challenge gate", { actor: actorA });
  const claim = board.postNote("challenge-gate", "A", "claim", { actor: actorA, kind: "claim", material: true });
  const challenge = board.postNote("challenge-gate", "B", "counterexample", {
    actor: actorB, kind: "challenge", targets: [{ topic: "challenge-gate", seq: claim.seq }],
  });
  board.postNote("challenge-gate", "A", "bounded", {
    actor: actorA, kind: "convergence", verdict: "claim unresolved", unresolved: [{ topic: "challenge-gate", seq: claim.seq }],
  });
  assert.equal(board.assessCloseReadiness("challenge-gate").ready, false);
  board.postNote("challenge-gate", "A", "explicitly accept challenge", {
    actor: actorA, kind: "convergence", verdict: "bounded close accepts challenge", unresolved: [{ topic: "challenge-gate", seq: claim.seq }, { topic: "challenge-gate", seq: challenge.seq }],
  });
  assert.equal(board.assessCloseReadiness("challenge-gate").ready, true);
  board.closeTopic("challenge-gate", { actor: actorA });
});

test("P1: post-convergence material work, retracted verification, and cross-topic challenge all block close", () => {
  board.openTopic("cross-source", "cross source", { actor: actorA });
  const remoteClaim = board.postNote("cross-source", "A", "remote material claim", { actor: actorA, kind: "claim", material: true });
  board.openTopic("close-graph", "close graph", { actor: actorA, relations: [{ type: "depends-on", topic: "cross-source" }] });
  const claim = board.postNote("close-graph", "A", "claim", { actor: actorA, kind: "claim", material: true });
  const verification = board.postNote("close-graph", "B", "verify", { actor: actorB, kind: "verification", targets: [{ topic: "close-graph", seq: claim.seq }] });
  board.postNote("close-graph", "A", "initial convergence", { actor: actorA, kind: "convergence", verdict: "done" });
  board.postNote("close-graph", "B", "retract verification", { actor: actorB, kind: "retraction", targets: [{ topic: "close-graph", seq: verification.seq }] });
  board.postNote("close-graph", "B", "local challenge", { actor: actorB, kind: "challenge", targets: [{ topic: "close-graph", seq: claim.seq }] });
  const readiness = board.assessCloseReadiness("close-graph");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.openMaterialClaims.some(ref => ref.topic === "close-graph" && ref.seq === claim.seq));
  assert.ok(readiness.openChallenges.some(ref => ref.topic === "close-graph"));

  board.openTopic("incoming-challenger", "incoming objection", { actor: actorB, relations: [{ type: "conflicts-with", topic: "close-graph" }] });
  board.postNote("incoming-challenger", "B", "challenge base claim", {
    actor: actorB, kind: "challenge", targets: [{ topic: "close-graph", seq: claim.seq }],
  });
  const incoming = board.assessCloseReadiness("close-graph");
  assert.equal(incoming.ready, false);
  assert.ok(incoming.openChallenges.some(ref => ref.topic === "incoming-challenger"));

  board.postNote("incoming-challenger", "B", "bounded challenger close", {
    actor: actorB, kind: "convergence", verdict: "challenge remains pending", unresolved: [{ topic: "close-graph", seq: claim.seq }],
  });
  board.closeTopic("incoming-challenger", { actor: actorB });
  const archivedIncoming = board.assessCloseReadiness("close-graph");
  assert.equal(archivedIncoming.ready, false);
  assert.ok(archivedIncoming.openChallenges.some(ref => ref.topic === "incoming-challenger"));
});

test("P0: catalog exposes only metadata and keeps unrelated note bodies outside the catalog", () => {
  board.openTopic("x", "X goal", { actor: actorA, relations: [{ type: "supports", topic: "claims" }] });
  board.postNote("x", "A", "SECRET-X-BODY", { actor: actorA, kind: "evidence", priority: "critical" });
  board.openTopic("y", "Y goal", { actor: actorB });
  board.postNote("y", "B", "SECRET-Y-BODY", { actor: actorB, kind: "claim", material: true });
  const hotCatalog = board.listOpenTopicCatalog();
  assert.deepEqual(hotCatalog.map(item => item.id).filter(id => id === "x" || id === "y"), ["x", "y"]);
  assert.doesNotMatch(JSON.stringify(hotCatalog), /SECRET-[XY]-BODY/);
  const catalog = board.listTopicCatalog();
  const x = catalog.find(item => item.id === "x")!;
  assert.equal(x.lastSeq, 1);
  assert.equal(x.criticalCount, 1);
  assert.deepEqual(x.participants, ["actor-a"]);
  assert.deepEqual(x.relations, [{ type: "supports", topic: "claims" }]);
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET-[XY]-BODY/);
});

test("P2: dead owner lock is reclaimed, live lock is not stolen, and release is fenced", () => {
  const topic = "locks";
  board.openTopic(topic, "lock recovery", { actor: actorA });
  const lock = join(cwd, ".pi-board", "topics", `${topic}.jsonl.lock`);
  writeFileSync(lock, JSON.stringify({ version: 1, pid: 999_999_999, processStart: null, token: "dead", acquiredAt: Date.now() }), "utf-8");
  board.postNote(topic, "A", "reclaims dead owner", { actor: actorA, kind: "evidence" });
  assert.ok(!existsSync(lock));
  writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, processStart: null, token: "live", acquiredAt: 0 }), "utf-8");
  assert.throws(() => board.postNote(topic, "A", "must not steal live lock", { actor: actorA, kind: "evidence" }), /not provably dead/);
  assert.equal(JSON.parse(readFileSync(lock, "utf-8")).token, "live");
  rmSync(lock, { force: true });
});

test("P2: malformed lock is never treated as free or silently reclaimed", () => {
  const topic = "malformed-lock";
  board.openTopic(topic, "malformed lock", { actor: actorA });
  const lock = join(cwd, ".pi-board", "topics", `${topic}.jsonl.lock`);
  writeFileSync(lock, "not-json", "utf-8");
  assert.throws(
    () => board.postNote(topic, "A", "must fail", { actor: actorA, kind: "evidence" }),
    /not provably dead/,
  );
  assert.equal(readFileSync(lock, "utf-8"), "not-json");
  rmSync(lock, { force: true });
});

test("P2: open recovery rebuilds only a missing derived board.md, preserving source JSONL", () => {
  const topic = "open-recovery";
  board.openTopic(topic, "recover derived view", { actor: actorA });
  board.postNote(topic, "A", "source-of-truth", { actor: actorA, kind: "evidence" });
  const jsonl = join(cwd, ".pi-board", "topics", `${topic}.jsonl`);
  const boardMd = join(cwd, ".pi-board", "topics", `${topic}.board.md`);
  const before = readFileSync(jsonl, "utf-8");
  rmSync(boardMd);
  board.listOpenTopics();
  assert.ok(existsSync(boardMd));
  assert.match(readFileSync(boardMd, "utf-8"), /source-of-truth/);
  assert.equal(readFileSync(jsonl, "utf-8"), before);
});

test("P2: recovery refuses a live lock whose token differs from the journal", () => {
  const topic = "journal-token-mismatch";
  board.openTopic(topic, "token fence", { actor: actorA });
  const active = join(cwd, ".pi-board", "topics", `${topic}.jsonl`);
  const journal = join(cwd, ".pi-board", "topics", ".transactions", `${topic}.close.json`);
  const lock = `${active}.lock`;
  const archiveDir = join(cwd, ".pi-board", "topics", "archive");
  const meta = JSON.parse(readFileSync(active, "utf-8").split("\n")[0].slice(6));
  const closed = { ...meta, status: "closed", closedAt: Date.now(), integrityVersion: 1, finalSeq: 0, closedBy: actorA };
  writeFileSync(journal, JSON.stringify({
    version: 1, topicId: topic, token: "journal-owner", activeJsonl: active,
    activeBoardMd: join(cwd, ".pi-board", "topics", `${topic}.board.md`), archiveJsonl: join(archiveDir, `${topic}.jsonl`),
    archiveBoardMd: join(archiveDir, `${topic}.board.md`), archiveSummary: join(archiveDir, `${topic}.summary.md`),
    archiveDecisions: join(archiveDir, `${topic}.decisions.md`), closedMeta: closed, summary: "summary", decisions: "decisions", phase: "prepared",
  }), "utf-8");
  writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, processStart: null, token: "new-owner", acquiredAt: Date.now() }), "utf-8");
  assert.throws(() => board.recoverCloseTransaction(topic), /lock token mismatch/);
  assert.ok(existsSync(journal), "mismatched journal remains auditable");
  rmSync(lock, { force: true });
  rmSync(journal, { force: true });
});

test("P2: pre-commit torn active JSONL preserves its journal instead of deleting recovery evidence", () => {
  const topic = "torn-precommit";
  board.openTopic(topic, "torn precommit", { actor: actorA });
  board.postNote(topic, "A", "evidence", { actor: actorA, kind: "evidence" });
  const active = join(cwd, ".pi-board", "topics", `${topic}.jsonl`);
  const journal = join(cwd, ".pi-board", "topics", ".transactions", `${topic}.close.json`);
  const archiveDir = join(cwd, ".pi-board", "topics", "archive");
  const originalActive = readFileSync(active, "utf-8");
  const meta = JSON.parse(originalActive.split("\n")[0].slice(6));
  const closed = { ...meta, status: "closed", closedAt: Date.now(), integrityVersion: 1, finalSeq: 1, closedBy: actorA };
  writeFileSync(journal, JSON.stringify({
    version: 1, topicId: topic, token: "crashed", activeJsonl: active,
    activeBoardMd: join(cwd, ".pi-board", "topics", `${topic}.board.md`), archiveJsonl: join(archiveDir, `${topic}.jsonl`),
    archiveBoardMd: join(archiveDir, `${topic}.board.md`), archiveSummary: join(archiveDir, `${topic}.summary.md`),
    archiveDecisions: join(archiveDir, `${topic}.decisions.md`), closedMeta: closed, summary: "summary", decisions: "decisions", phase: "prepared",
  }), "utf-8");
  writeFileSync(active, `#META#${JSON.stringify(closed)}\n{torn`, "utf-8");
  assert.throws(() => board.recoverCloseTransaction(topic), /torn note bytes|invalid note shape/);
  assert.ok(existsSync(journal), "failed recovery must retain journal evidence");
  // Isolate this intentional unrecoverable fixture from later list/recovery tests.
  writeFileSync(active, originalActive, "utf-8");
  rmSync(journal, { force: true });
});

test("P2: close recovery uses archive JSONL as one commit point and completes artifacts", () => {
  const topic = "recovery";
  board.openTopic(topic, "recover close", { actor: actorA });
  board.postNote(topic, "A", "evidence", { actor: actorA, kind: "evidence" });
  const active = join(cwd, ".pi-board", "topics", `${topic}.jsonl`);
  const archiveDir = join(cwd, ".pi-board", "topics", "archive");
  const archive = join(archiveDir, `${topic}.jsonl`);
  const journalDir = join(cwd, ".pi-board", "topics", ".transactions");
  const summary = "<!-- PI_BOARD_SUMMARY v1 totalNotes=1 -->\n# Summary: recovery\n";
  const meta = JSON.parse(readFileSync(active, "utf-8").split("\n")[0].slice(6));
  const closed = { ...meta, status: "closed", closedAt: Date.now(), integrityVersion: 1, finalSeq: 1, closedBy: actorA };
  const lines = readFileSync(active, "utf-8").split("\n");
  lines[0] = `#META#${JSON.stringify(closed)}`;
  writeFileSync(active, lines.join("\n"), "utf-8");
  rmSync(archiveDir, { recursive: true, force: true });
  // Simulate crash immediately after the unique commit rename and before side artifacts.
  requireRename(active, archive);
  writeFileSync(join(journalDir, `${topic}.close.json`), JSON.stringify({
    version: 1, topicId: topic, token: "crashed", activeJsonl: active,
    activeBoardMd: join(cwd, ".pi-board", "topics", `${topic}.board.md`), archiveJsonl: archive,
    archiveBoardMd: join(archiveDir, `${topic}.board.md`), archiveSummary: join(archiveDir, `${topic}.summary.md`),
    archiveDecisions: join(archiveDir, `${topic}.decisions.md`), closedMeta: closed, summary,
    decisions: "# Decisions: recovery\n", phase: "jsonl-committed",
  }), "utf-8");
  board.listTopics();
  assert.ok(existsSync(archive));
  assert.ok(existsSync(join(archiveDir, `${topic}.board.md`)), "derived board.md is rebuilt from committed archive JSONL");
  assert.ok(existsSync(join(archiveDir, `${topic}.summary.md`)));
  assert.ok(!existsSync(join(journalDir, `${topic}.close.json`)));
});

function requireRename(from: string, to: string): void {
  mkdirSync(join(to, ".."), { recursive: true });
  renameSync(from, to);
}
