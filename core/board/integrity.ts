// ADR-0020: Board integrity audit — detect append-only JSONL corruption.
//
// Failure modes from a real-world incident (Git conflict rolled back a closed
// topic's archive JSONL; notes #31–#35 survived only in summary.md):
//   1. Mid-file rollback / gap: note seq stops being strictly 1,2,3,…,N.
//   2. Tail truncation: JSONL ends at #30 while close-time summary.md still
//      cites #35. The file is a valid prefix, so seq continuity alone cannot
//      see it — the summary witness is the only cross-check.
//   3. Witness forgery: the goal is a free multi-line user field embedded in
//      the summary; parsing anything below the first line lets it forge or
//      hide the witness. First-line anchoring (v1) and structured legacy
//      parsing (skip the exact goal bytes from the META) close both paths.
//
// Policy: fail loud. A corrupted topic must throw, never silently return a
// shorter list (callers would mistake the rollback for the real history).
// "Unverified" is an explicit third state, never silently merged with "ok".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getStorageRoot } from "../storage/index.ts";
import type { Note, Topic, WitnessKind } from "./types.ts";

export interface ArchivedIntegrityReport {
  topicId: string;
  maxSeq: number;
  issues: string[];
  witnessKind: WitnessKind;
}

function assertTopicId(topicId: string): void {
  if (typeof topicId !== "string" || topicId.length === 0 || /[\\/\0]/.test(topicId)) {
    throw new Error("Topic ID must be one non-empty path segment");
  }
}

export function archivedTopicPaths(topicId: string): { jsonl: string; summary: string } {
  assertTopicId(topicId);
  const archiveDir = join(getStorageRoot(), "topics", "archive");
  return {
    jsonl: join(archiveDir, `${topicId}.jsonl`),
    summary: join(archiveDir, `${topicId}.summary.md`),
  };
}

/**
 * Finite number AND representable as a Date. 1e100 passes Number.isFinite
 * but new Date(1e100).toISOString() throws RangeError — timestamps must be
 * valid in the Date range or rendering later explodes mid-write.
 */
function isValidTimestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

/** Runtime shape guard for Topic. Returns a failure reason or null. */
export function validateTopicShape(topic: unknown): string | null {
  if (typeof topic !== "object" || topic === null) return "META is not an object";
  const t = topic as Record<string, unknown>;
  if (typeof t.id !== "string" || t.id.length === 0) return "META id is not a non-empty string";
  if (typeof t.goal !== "string") return "META goal is not a string";
  if (t.status !== "open" && t.status !== "closed") return "META status is not open/closed";
  if (!isValidTimestamp(t.createdAt)) return "META createdAt is not a valid date";
  if (t.closedAt !== undefined && !isValidTimestamp(t.closedAt)) return "META closedAt is not a valid date";
  if (t.integrityVersion !== undefined && t.integrityVersion !== 1) {
    return "META integrityVersion is not 1";
  }
  if (t.finalSeq !== undefined && (typeof t.finalSeq !== "number" || !Number.isInteger(t.finalSeq))) {
    return "META finalSeq is not an integer";
  }
  return null;
}

/** Runtime shape guard for Note. Returns a failure reason or null. */
export function validateNoteShape(note: unknown): string | null {
  if (typeof note !== "object" || note === null) return "not an object";
  const n = note as Record<string, unknown>;
  if (typeof n.seq !== "number" || !Number.isInteger(n.seq)) return "seq is not an integer";
  if (typeof n.author !== "string" || n.author.length === 0) return "author is not a non-empty string";
  if (!isValidTimestamp(n.timestamp)) return "timestamp is not a valid date";
  if (typeof n.content !== "string") return "content is not a string";
  if (n.tags !== undefined && (!Array.isArray(n.tags) || n.tags.some(t => typeof t !== "string"))) {
    return "tags is not a string array";
  }
  if (n.priority !== undefined && n.priority !== "critical") return "priority is not \"critical\"";
  return null;
}

/**
 * Note seq must be exactly 1,2,3,…,N. Any gap, rollback, duplicate, or
 * non-integer breaks the append-only invariant and means an external rewrite
 * (or Git conflict) touched the file.
 */
export function validateNoteSeq(notes: Note[]): string[] {
  const issues: string[] = [];
  for (let i = 0; i < notes.length; i += 1) {
    const expected = i + 1;
    const seq = notes[i]?.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq !== expected) {
      issues.push(`seq discontinuity: expected #${expected}, got ${String(seq)}`);
      break; // one broken position is enough to fail the file
    }
  }
  return issues;
}

/**
 * v1 machine witness: the summary's VERY FIRST LINE
 * (`<!-- PI_BOARD_SUMMARY v1 totalNotes=N -->`), or null when absent.
 * First-line anchoring is what keeps the free-form goal (embedded verbatim
 * below) from forging or hiding the witness.
 */
export function totalNotesInSummary(summary: string): number | null {
  const firstLine = summary.split("\n", 1)[0]?.trim();
  const match = firstLine?.match(/^<!--\s*PI_BOARD_SUMMARY\s+v1\s+totalNotes=(\d+)\s*-->\s*$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Legacy structured parse — strict block form.
 *
 * Locate the EXACT header block built from the JSONL META's id and goal
 * bytes, then parse ONLY what immediately follows it (no /m flag):
 *
 *   # Summary: <id>
 *   (blank)
 *   **Goal**: <goal>
 *   **Duration**: <line>
 *   **Total Notes**: N
 *   **Participants**: ...
 *
 * The goal region is skipped by exact-byte matching, so forged
 * `**Total Notes**: 999` lines or `##` headings inside the goal cannot
 * interfere. Without /m, `^` anchors at the block end — a corrupted
 * canonical line cannot fall through to a forged Duration/Total Notes pair
 * inside a note body. Participants must follow immediately, so body text
 * cannot complete the match either.
 */
export function legacyTotalNotes(summary: string, topic: Topic): number | null {
  const headerBlock = `# Summary: ${topic.id}\n\n**Goal**: ${topic.goal}\n**Duration**:`;
  const blockStart = summary.indexOf(headerBlock);
  if (blockStart < 0) return null;
  const afterBlock = summary.slice(blockStart + headerBlock.length);
  const match = afterBlock.match(/^[^\n]*\n\*\*Total Notes\*\*:\s*(\d+)\s*\n\*\*Participants\*\*:/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Audit one archived topic; never throws for content problems — returns issues. */
export function auditArchivedTopic(topicId: string): ArchivedIntegrityReport {
  const { jsonl, summary } = archivedTopicPaths(topicId);
  if (!existsSync(jsonl)) throw new Error(`Archived topic "${topicId}" not found`);

  const lines = readFileSync(jsonl, "utf-8").split("\n").filter(line => line.trim());
  const issues: string[] = [];

  let topic: Topic | null = null;
  if (!lines[0]?.startsWith("#META#")) {
    issues.push("missing META line");
  } else {
    try {
      const parsed = JSON.parse(lines[0].slice(6)) as Topic;
      const shapeIssue = validateTopicShape(parsed);
      if (shapeIssue) {
        issues.push(`META shape invalid: ${shapeIssue}`);
      } else {
        topic = parsed;
        if (topic.id !== topicId || topic.status !== "closed") {
          issues.push(`META identity/status mismatch (${topic.id}/${topic.status})`);
        }
      }
    } catch {
      issues.push("META line is not valid JSON");
    }
  }

  const notes: Note[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    try {
      const parsed = JSON.parse(lines[i]) as Note;
      const shapeIssue = validateNoteShape(parsed);
      if (shapeIssue) {
        issues.push(`line ${i + 1} shape invalid: ${shapeIssue}`);
        continue;
      }
      notes.push(parsed);
    } catch {
      issues.push(`line ${i + 1} is not valid JSON`);
    }
  }
  issues.push(...validateNoteSeq(notes));
  const maxSeq = notes.reduce(
    (max, note) => (typeof note?.seq === "number" && note.seq > max ? note.seq : max),
    0,
  );

  // Cross-check against the close-time summary. Three states, never merged:
  //   v1                META integrityVersion=1 → witness REQUIRED. Four
  //                     INDEPENDENT checks so one failure never hides another
  //                     (witness deleted + JSONL truncated reports both).
  //   legacy-structured no version → strict block header parse (goal-skip).
  //   unverified        nothing parseable → cross-check honestly skipped.
  let witnessKind: WitnessKind = "unverified";
  if (topic?.integrityVersion === 1) {
    witnessKind = "v1";
    if (typeof topic.finalSeq !== "number") {
      issues.push("v1 archive: META finalSeq missing");
    } else if (topic.finalSeq !== maxSeq) {
      issues.push(`v1 archive: finalSeq=${topic.finalSeq} vs JSONL maxSeq=#${maxSeq} mismatch`);
    }
    if (!existsSync(summary)) {
      issues.push("v1 archive is missing summary.md");
    } else {
      const witness = totalNotesInSummary(readFileSync(summary, "utf-8"));
      if (witness === null) {
        issues.push("v1 archive: summary witness line missing or malformed");
      } else if (witness !== topic.finalSeq || witness !== maxSeq) {
        issues.push(
          `v1 archive: witness=${witness} disagrees (finalSeq=${topic.finalSeq}, JSONL maxSeq=#${maxSeq})`,
        );
      }
    }
  } else if (topic && existsSync(summary)) {
    const legacy = legacyTotalNotes(readFileSync(summary, "utf-8"), topic);
    if (legacy !== null) {
      witnessKind = "legacy-structured";
      if (legacy > maxSeq) {
        issues.push(
          `summary Total Notes=${legacy} but JSONL max seq=#${maxSeq}: tail notes lost (Git conflict rollback?)`,
        );
      } else if (legacy < maxSeq) {
        issues.push(
          `summary Total Notes=${legacy} lags JSONL max seq=#${maxSeq}: summary rewritten/rolled back?`,
        );
      }
    }
  }

  return { topicId, maxSeq, issues, witnessKind };
}

/** Fail loud on any integrity issue; returns the full report either way. */
export function assertArchivedTopicIntact(topicId: string): ArchivedIntegrityReport {
  const report = auditArchivedTopic(topicId);
  if (report.issues.length > 0) {
    throw new Error(
      `Archived topic "${topicId}" is corrupted: ${report.issues.join("; ")}`,
    );
  }
  return report;
}
