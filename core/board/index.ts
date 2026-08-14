import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getStorageRoot, ensureDir } from "../storage/index.ts";
import { appendEvent } from "../events/index.ts";
import type { Topic, Note, TopicMeta } from "./types.ts";

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
    if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);
    // Read existing notes to get next seq
    const notes = readNotes(topicId);
    const seq = notes.length > 0 ? Math.max(...notes.map(note => note.seq)) + 1 : 1;

    const note: Note = {
      seq,
      author,
      timestamp: Date.now(),
      content,
      ...(opts?.tags && { tags: opts.tags }),
      ...(opts?.priority && { priority: opts.priority }),
    };

    appendFileSync(jsonlPath, JSON.stringify(note) + "\n", "utf-8");

    // Re-render board.md
    const topic = getTopicMeta(topicId);
    const allNotes = readNotes(topicId);
    renderBoardMd(topicId, topic, allNotes);

    appendEvent("board_post", { topic: topicId, seq, author });
    return note;
  } finally {
    releaseLock(topicId);
  }
}

export function readNotes(topicId: string, since?: number): Note[] {
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);

  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(l => l.trim());
  const notes: Note[] = [];
  for (const line of lines) {
    if (line.startsWith("#META#")) continue;
    const note = JSON.parse(line) as Note;
    if (since === undefined || note.seq > since) {
      notes.push(note);
    }
  }
  return notes;
}

/** Read one closed topic from its immutable archive JSONL. */
export function readArchivedTopic(topicId: string): { topic: Topic; notes: Note[] } {
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
  };
}

export function listTopics(): TopicMeta[] {
  const dir = topicsDir();
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  const topics: TopicMeta[] = [];

  for (const file of files) {
    const topicId = file.replace(".jsonl", "");
    const meta = getTopicMeta(topicId);
    const notes = readNotes(topicId);
    topics.push({ ...meta, noteCount: notes.length });
  }

  // Also check archive
  const archiveDir = join(dir, "archive");
  if (existsSync(archiveDir)) {
    const archiveFiles = readdirSync(archiveDir).filter(f => f.endsWith(".jsonl"));
    for (const file of archiveFiles) {
      const topicId = file.replace(".jsonl", "");
      const jsonlPath = join(archiveDir, `${topicId}.jsonl`);
      const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(l => l.trim());
      const metaLine = lines.find(l => l.startsWith("#META#"));
      if (metaLine) {
        const meta = JSON.parse(metaLine.slice(6)) as Topic;
        const noteCount = lines.filter(l => !l.startsWith("#META#")).length;
        topics.push({ ...meta, noteCount });
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
      const topic = getTopicMeta(topicId);
      if (topic.status === "open") topics.push(topic);
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
    const topic = getTopicMeta(topicId);
    if (topic.status === "closed") throw new Error(`Topic "${topicId}" is already closed`);

    const notes = readNotes(topicId);
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

    const closedTopic: Topic = { ...topic, status: "closed", closedAt: Date.now() };
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
function readTopicMetaLine(jsonlPath: string): string {
  const fd = openSync(jsonlPath, "r");
  const chunks: Buffer[] = [];
  let position = 0;
  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(1024);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const newline = buffer.indexOf(0x0a, 0);
      chunks.push(buffer.subarray(0, newline >= 0 && newline < bytesRead ? newline : bytesRead));
      if (newline >= 0 && newline < bytesRead) break;
      position += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function getTopicMeta(topicId: string): Topic {
  const jsonlPath = topicJsonlPath(topicId);
  const firstLine = readTopicMetaLine(jsonlPath);
  if (!firstLine.startsWith("#META#")) {
    throw new Error(`Invalid topic file: missing META line for "${topicId}"`);
  }
  return JSON.parse(firstLine.slice(6)) as Topic;
}

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
  let md = `# Summary: ${topic.id}\n\n`;
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
