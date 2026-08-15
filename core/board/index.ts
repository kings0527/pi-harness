import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getStorageRoot, ensureDir } from "../storage/index.ts";
import { appendEvent } from "../events/index.ts";
import { assertArchivedTopicIntact, validateNoteSeq, validateNoteShape, validateTopicShape } from "./integrity.ts";
import type { Topic, Note, TopicMeta, WitnessKind } from "./types.ts";

function topicsDir(): string { return join(getStorageRoot(), "topics"); }
function assertTopicId(topicId: string): void {
  if (typeof topicId !== "string" || topicId.length === 0 || /[\\/\0]/.test(topicId)) {
    throw new Error("Topic ID must be one non-empty path segment");
  }
}

function topicJsonlPath(topicId: string): string {
  assertTopicId(topicId);
  return join(topicsDir(), `${topicId}.jsonl`);
}
function topicBoardMdPath(topicId: string): string {
  assertTopicId(topicId);
  return join(topicsDir(), `${topicId}.board.md`);
}
function archivedTopicJsonlPath(topicId: string): string {
  assertTopicId(topicId);
  return join(topicsDir(), "archive", `${topicId}.jsonl`);
}

/** Detect the legacy persisted shape where this ID was closed before reuse. */
export function hasArchivedTopic(topicId: string): boolean {
  return existsSync(archivedTopicJsonlPath(topicId));
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

// Atomically create the sidecar: existence checks alone race across agents.
function acquireLock(topicId: string, timeoutMs = 5000): boolean {
  const lockPath = topicJsonlPath(topicId) + ".lock";
  const start = Date.now();
  while (true) {
    let created = false;
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      created = true;
      try {
        writeFileSync(fd, String(process.pid), "utf-8");
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error: any) {
      if (created) {
        try {
          unlinkSync(lockPath);
        } catch (cleanupError: any) {
          if (cleanupError?.code !== "ENOENT") throw cleanupError;
        }
      }
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - start >= timeoutMs) return false;
      Atomics.wait(lockWait, 0, 0, 10);
    }
  }
}

function releaseLock(topicId: string): void {
  const lockPath = topicJsonlPath(topicId) + ".lock";
  try {
    unlinkSync(lockPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * ADR-0020: the single validated entry for every live-topic read. A live
 * JSONL is only trustworthy when: META is the first line (and only there),
 * id matches, status is open, every other line is a Note, and seq runs
 * 1,2,3,…,N. Anything else means an external rewrite (Git conflict) and
 * throws — callers never mistake a corrupted file for real history, and
 * writes to a corrupted topic are refused before any append.
 */
function readActiveTopic(topicId: string): { topic: Topic; notes: Note[] } {
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);

  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(l => l.trim());
  if (!lines[0]?.startsWith("#META#")) {
    throw new Error(`Topic "${topicId}" JSONL is corrupted: missing META line`);
  }
  let topic: Topic;
  try {
    topic = JSON.parse(lines[0].slice(6)) as Topic;
  } catch {
    throw new Error(`Topic "${topicId}" JSONL is corrupted: META line is not valid JSON`);
  }
  const topicShapeIssue = validateTopicShape(topic);
  if (topicShapeIssue) {
    throw new Error(`Topic "${topicId}" JSONL is corrupted: META shape invalid: ${topicShapeIssue}`);
  }
  if (topic.id !== topicId || topic.status !== "open") {
    throw new Error(
      `Topic "${topicId}" JSONL is corrupted: META identity/status mismatch (${topic.id}/${topic.status})`,
    );
  }
  const notes: Note[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    let note: Note;
    try {
      note = JSON.parse(lines[i]) as Note;
    } catch {
      throw new Error(`Topic "${topicId}" JSONL is corrupted: line ${i + 1} is not valid JSON`);
    }
    const noteShapeIssue = validateNoteShape(note);
    if (noteShapeIssue) {
      throw new Error(
        `Topic "${topicId}" JSONL is corrupted: line ${i + 1} shape invalid: ${noteShapeIssue}`,
      );
    }
    notes.push(note);
  }
  const seqIssues = validateNoteSeq(notes);
  if (seqIssues.length > 0) {
    throw new Error(
      `Topic "${topicId}" JSONL is corrupted (seq gap/rollback — external rewrite or Git conflict?): ${seqIssues.join("; ")}`,
    );
  }
  return { topic, notes };
}

/**
 * A topic id is an append-only Board identity. Reusing it after close would
 * reset seq to 1 while active checkpoint cursors still refer to the former
 * incarnation, causing valid new notes to be skipped as already delivered.
 */
export function openTopic(topicId: string, goal: string): Topic {
  const jsonlPath = topicJsonlPath(topicId);
  if (!acquireLock(topicId)) {
    throw new Error(`Failed to acquire lock for topic "${topicId}" (timeout)`);
  }
  try {
    // A topic id is an append-only Board identity. Reusing it after close would
    // reset seq to 1 while active checkpoint cursors still refer to the former
    // incarnation, causing valid new notes to be skipped as already delivered.
    if (hasArchivedTopic(topicId)) {
      throw new Error(`Topic "${topicId}" already exists in archive`);
    }
    const topic: Topic = { id: topicId, goal, status: "open", createdAt: Date.now() };
    // ADR-0020: guard BEFORE the first byte is written — a shape-invalid
    // Topic must never be persisted and discovered later via re-read.
    const shapeIssue = validateTopicShape(topic);
    if (shapeIssue) {
      throw new Error(`Topic "${topicId}" rejected before write: ${shapeIssue}`);
    }
    try {
      writeFileSync(jsonlPath, `#META#${JSON.stringify(topic)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch (error: any) {
      if (error?.code === "EEXIST") throw new Error(`Topic "${topicId}" already exists`);
      throw error;
    }
    renderBoardMd(topicId, topic, []);
    appendEvent("board_open", { topic: topicId, goal });
    return topic;
  } finally {
    releaseLock(topicId);
  }
}

export function postNote(topicId: string, author: string, content: string, opts?: { tags?: string[]; priority?: "critical" }): Note {
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);

  if (!acquireLock(topicId)) {
    throw new Error(`Failed to acquire lock for topic "${topicId}" (timeout)`);
  }
  try {
    // ADR-0020: validate the whole file inside the lock, BEFORE appending —
    // a corrupted META (e.g. status flipped to "closed" by a Git conflict)
    // refuses the write instead of silently continuing a damaged topic.
    const { topic, notes } = readActiveTopic(topicId);
    const seq = notes.length > 0 ? notes[notes.length - 1].seq + 1 : 1;

    const note: Note = {
      seq,
      author,
      timestamp: Date.now(),
      content,
      ...(opts?.tags && { tags: opts.tags }),
      ...(opts?.priority && { priority: opts.priority }),
    };

    // ADR-0020: guard BEFORE the append — a shape-invalid Note must never
    // reach the file (e.g. author "" or an out-of-range timestamp).
    const noteShapeIssue = validateNoteShape(note);
    if (noteShapeIssue) {
      throw new Error(`Note rejected before write on topic "${topicId}": ${noteShapeIssue}`);
    }

    appendFileSync(jsonlPath, JSON.stringify(note) + "\n", "utf-8");

    // ADR-0020: post-write verification — re-read the file and confirm the
    // new note is really there, comparing the FULL note shape (not just
    // length and seq). A write that left the bytes unchanged (silent append
    // failure) must never pass as accepted.
    const after = readActiveTopic(topicId);
    const persisted = after.notes[after.notes.length - 1];
    if (after.notes.length !== notes.length + 1 || JSON.stringify(persisted) !== JSON.stringify(note)) {
      throw new Error(`Topic "${topicId}" append verification failed: note #${seq} not persisted intact`);
    }

    // Re-render board.md from the verified snapshot.
    renderBoardMd(topicId, after.topic, after.notes);

    appendEvent("board_post", { topic: topicId, seq, author });
    return note;
  } finally {
    releaseLock(topicId);
  }
}

export function readNotes(topicId: string, since?: number): Note[] {
  const { notes } = readActiveTopic(topicId);
  return since === undefined ? notes : notes.filter(note => note.seq > since);
}

/**
 * Read one closed topic from its immutable archive JSONL. The third field
 * carries the cross-check state so callers can distinguish "verified" from
 * "legacy-structured" from "unverified" instead of treating all no-issue
 * reads as equally trustworthy.
 */
export function readArchivedTopic(topicId: string): { topic: Topic; notes: Note[]; integrity: WitnessKind } {
  // ADR-0020: the archive must be an intact prefix of the close-time history.
  // seq continuity alone misses tail truncation; the summary cross-check catches it.
  const report = assertArchivedTopicIntact(topicId);
  const jsonlPath = archivedTopicJsonlPath(topicId);
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(line => line.trim());
  const metaLine = lines[0];
  if (!metaLine?.startsWith("#META#")) {
    throw new Error(`Invalid archived topic file: missing META line for "${topicId}"`);
  }
  const topic = JSON.parse(metaLine.slice(6)) as Topic;
  if (topic.id !== topicId || topic.status !== "closed") {
    throw new Error(`Invalid archived topic identity or status for "${topicId}"`);
  }
  return {
    topic,
    notes: lines.slice(1).map(line => JSON.parse(line) as Note),
    integrity: report.witnessKind,
  };
}

export function listTopics(): TopicMeta[] {
  const dir = topicsDir();
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  const topics: TopicMeta[] = [];

  for (const file of files) {
    const topicId = file.replace(".jsonl", "");
    const { topic, notes } = readActiveTopic(topicId);
    topics.push({ ...topic, noteCount: notes.length });
  }

  // Also check archive
  const archiveDir = join(dir, "archive");
  if (existsSync(archiveDir)) {
    const archiveFiles = readdirSync(archiveDir).filter(f => f.endsWith(".jsonl"));
    for (const file of archiveFiles) {
      const topicId = file.replace(".jsonl", "");
      // ADR-0020: a corrupted archive must abort the listing rather than
      // surface a silently truncated note count.
      const report = assertArchivedTopicIntact(topicId);
      const jsonlPath = join(archiveDir, `${topicId}.jsonl`);
      const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(l => l.trim());
      const metaLine = lines.find(l => l.startsWith("#META#"));
      if (metaLine) {
        const meta = JSON.parse(metaLine.slice(6)) as Topic;
        const noteCount = lines.filter(l => !l.startsWith("#META#")).length;
        topics.push({ ...meta, noteCount, integrity: report.witnessKind });
      }
    }
  }

  return topics;
}

/**
 * List only currently open topics without reading their note bodies or archive.
 * A concurrent close may remove a file after readdir; that topic is no longer
 * open and can be skipped. Other read/parse failures abort the whole listing so
 * callers never mistake an incomplete directory read for topic closures.
 */
export function listOpenTopics(): Topic[] {
  const files = readdirSync(topicsDir()).filter(file => file.endsWith(".jsonl"));
  const topics: Topic[] = [];
  for (const file of files) {
    const topicId = file.slice(0, -".jsonl".length);
    try {
      const { topic } = readActiveTopic(topicId);
      topics.push(topic);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return topics;
}

export function closeTopic(topicId: string): { summary: string; decisions: string } {
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);
  if (!acquireLock(topicId)) {
    throw new Error(`Failed to acquire lock for topic "${topicId}" (timeout)`);
  }
  try {
    if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);
    // ADR-0020: readActiveTopic enforces status === "open" here, so a META
    // flipped to "closed" by an external rewrite fails the close instead of
    // archiving a corrupted file.
    const { topic, notes } = readActiveTopic(topicId);
    const summary = generateSummary(topic, notes);
    const decisions = generateDecisions(topic, notes);

    const archiveDir = join(topicsDir(), "archive");
    ensureDir(archiveDir);
    const archiveTargets = [
      join(archiveDir, `${topicId}.jsonl`),
      join(archiveDir, `${topicId}.board.md`),
      join(archiveDir, `${topicId}.summary.md`),
      join(archiveDir, `${topicId}.decisions.md`),
    ];
    const collisions = archiveTargets.filter(path => existsSync(path));
    if (collisions.length > 0) {
      throw new Error(
        `Archive collision for topic "${topicId}"; active topic was preserved (${collisions.length} existing artifact${collisions.length === 1 ? "" : "s"})`,
      );
    }

    const closedTopic: Topic = {
      ...topic,
      status: "closed",
      closedAt: Date.now(),
      // ADR-0020: the META itself carries the machine witness, so a summary
      // witness deleted later cannot downgrade a v1 archive to "legacy".
      integrityVersion: 1,
      finalSeq: notes.length,
    };
    const lines = readFileSync(jsonlPath, "utf-8").split("\n");
    lines[0] = `#META#${JSON.stringify(closedTopic)}`;
    writeFileSync(jsonlPath, lines.join("\n"), "utf-8");

    renameSync(jsonlPath, archiveTargets[0]);

    const boardMdPath = topicBoardMdPath(topicId);
    if (existsSync(boardMdPath)) {
      renameSync(boardMdPath, archiveTargets[1]);
    }

    writeFileSync(archiveTargets[2], summary, { encoding: "utf-8", flag: "wx" });
    writeFileSync(archiveTargets[3], decisions, { encoding: "utf-8", flag: "wx" });

    appendEvent("board_close", { topic: topicId });
    return { summary, decisions };
  } finally {
    releaseLock(topicId);
  }
}

// Helper functions
function renderBoardMd(topicId: string, topic: Topic, notes: Note[]): void {
  let md = `# Topic: ${topicId}\n\n`;
  md += `**Goal**: ${topic.goal}\n`;
  md += `**Status**: ${topic.status}\n`;
  md += `**Created**: ${new Date(topic.createdAt).toISOString()}\n\n`;
  md += `---\n\n`;

  for (const note of notes) {
    const priorityTag = note.priority === "critical" ? " 🔴 CRITICAL" : "";
    const tagsStr = note.tags?.length ? ` [${note.tags.join(", ")}]` : "";
    md += `### #${note.seq} — ${note.author}${priorityTag}${tagsStr}\n`;
    md += `*${new Date(note.timestamp).toISOString()}*\n\n`;
    md += `${note.content}\n\n`;
  }

  // Atomic write: tmp + rename
  const boardMdPath = topicBoardMdPath(topicId);
  const tmpPath = `${boardMdPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, md, { encoding: "utf-8", flag: "wx" });
    renameSync(tmpPath, boardMdPath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function generateSummary(topic: Topic, notes: Note[]): string {
  // Machine witness MUST be the very first line, before any user-controlled
  // field (goal is a free multi-line string and could otherwise inject a
  // forged "**Total Notes**: 999" or a "##" heading that hides the real
  // header from the integrity cross-check).
  let md = `<!-- PI_BOARD_SUMMARY v1 totalNotes=${notes.length} -->\n`;
  md += `# Summary: ${topic.id}\n\n`;
  md += `**Goal**: ${topic.goal}\n`;
  md += `**Duration**: ${new Date(topic.createdAt).toISOString()} → ${new Date(Date.now()).toISOString()}\n`;
  md += `**Total Notes**: ${notes.length}\n`;
  md += `**Participants**: ${[...new Set(notes.map(n => n.author))].join(", ")}\n\n`;
  md += `## Discussion Highlights\n\n`;

  // Pin critical notes, then preserve the complete discussion (ADR-0012).
  const critical = notes.filter(n => n.priority === "critical");
  if (critical.length > 0) {
    md += `### Critical Notes\n\n`;
    for (const n of critical) {
      md += `- [#${n.seq}] ${n.author}: ${n.content}\n`;
    }
    md += `\n`;
  }

  md += `### Complete Activity\n\n`;
  for (const n of notes) {
    md += `- [#${n.seq}] ${n.author}: ${n.content}\n`;
  }

  return md;
}

function generateDecisions(topic: Topic, notes: Note[]): string {
  let md = `# Decisions: ${topic.id}\n\n`;
  md += `**Goal**: ${topic.goal}\n\n`;
  md += `## Key Findings & Decisions\n\n`;

  // Critical notes are decisions by default
  const critical = notes.filter(n => n.priority === "critical");
  if (critical.length > 0) {
    for (const n of critical) {
      md += `### Decision from ${n.author} (seq #${n.seq})\n\n`;
      md += `${n.content}\n\n`;
    }
  }

  // Last note often contains conclusion
  if (notes.length > 0) {
    const last = notes[notes.length - 1];
    md += `### Final Note (seq #${last.seq}, by ${last.author})\n\n`;
    md += `${last.content}\n\n`;
  }

  md += `---\n\n`;
  md += `*Generated at topic close. Use \`distill\` to elevate conclusions to knowledge.*\n`;

  return md;
}
