import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getStorageRoot, ensureDir } from "../storage/index.ts";
import { appendEvent } from "../events/index.ts";
import type { Topic, Note, TopicMeta } from "./types.ts";

function topicsDir(): string { return join(getStorageRoot(), "topics"); }
function topicJsonlPath(topicId: string): string { return join(topicsDir(), `${topicId}.jsonl`); }
function topicBoardMdPath(topicId: string): string { return join(topicsDir(), `${topicId}.board.md`); }

export function openTopic(topicId: string, goal: string): Topic {
  const jsonlPath = topicJsonlPath(topicId);
  if (existsSync(jsonlPath)) {
    throw new Error(`Topic "${topicId}" already exists`);
  }
  const topic: Topic = { id: topicId, goal, status: "open", createdAt: Date.now() };
  // Write meta as first line (prefixed with #META#)
  writeFileSync(jsonlPath, `#META#${JSON.stringify(topic)}\n`, "utf-8");
  renderBoardMd(topicId, topic, []);
  appendEvent("board_open", { topic: topicId, goal });
  return topic;
}

export function postNote(topicId: string, author: string, content: string, opts?: { tags?: string[]; priority?: "critical" }): Note {
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);

  // Read existing notes to get next seq
  const notes = readNotes(topicId);
  const seq = notes.length > 0 ? notes[notes.length - 1].seq + 1 : 1;

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

export function closeTopic(topicId: string): { summary: string; decisions: string } {
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);

  const topic = getTopicMeta(topicId);
  if (topic.status === "closed") throw new Error(`Topic "${topicId}" is already closed`);

  const notes = readNotes(topicId);

  // Generate summary
  const summary = generateSummary(topic, notes);
  const decisions = generateDecisions(topic, notes);

  // Update meta to closed
  const closedTopic: Topic = { ...topic, status: "closed", closedAt: Date.now() };
  const lines = readFileSync(jsonlPath, "utf-8").split("\n");
  lines[0] = `#META#${JSON.stringify(closedTopic)}`;
  writeFileSync(jsonlPath, lines.join("\n"), "utf-8");

  // Move to archive
  const archiveDir = join(topicsDir(), "archive");
  ensureDir(archiveDir);

  renameSync(jsonlPath, join(archiveDir, `${topicId}.jsonl`));

  const boardMdPath = topicBoardMdPath(topicId);
  if (existsSync(boardMdPath)) {
    renameSync(boardMdPath, join(archiveDir, `${topicId}.board.md`));
  }

  // Write summary.md and decisions.md
  writeFileSync(join(archiveDir, `${topicId}.summary.md`), summary, "utf-8");
  writeFileSync(join(archiveDir, `${topicId}.decisions.md`), decisions, "utf-8");

  appendEvent("board_close", { topic: topicId });
  return { summary, decisions };
}

// Helper functions
function getTopicMeta(topicId: string): Topic {
  const jsonlPath = topicJsonlPath(topicId);
  const firstLine = readFileSync(jsonlPath, "utf-8").split("\n")[0];
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

  writeFileSync(topicBoardMdPath(topicId), md, "utf-8");
}

function generateSummary(topic: Topic, notes: Note[]): string {
  let md = `# Summary: ${topic.id}\n\n`;
  md += `**Goal**: ${topic.goal}\n`;
  md += `**Duration**: ${new Date(topic.createdAt).toISOString()} → ${new Date(Date.now()).toISOString()}\n`;
  md += `**Total Notes**: ${notes.length}\n`;
  md += `**Participants**: ${[...new Set(notes.map(n => n.author))].join(", ")}\n\n`;
  md += `## Discussion Highlights\n\n`;

  // Include critical notes and last few notes
  const critical = notes.filter(n => n.priority === "critical");
  if (critical.length > 0) {
    md += `### Critical Notes\n\n`;
    for (const n of critical) {
      md += `- [#${n.seq}] ${n.author}: ${n.content}\n`;
    }
    md += `\n`;
  }

  const recent = notes.slice(-5);
  md += `### Recent Activity\n\n`;
  for (const n of recent) {
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
