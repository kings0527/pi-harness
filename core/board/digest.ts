import { createHash } from "node:crypto";
import { readNotes } from "./index.ts";
import type { Note } from "./types.ts";
import { boundedExcerpt, boundedIntEnv } from "../text-budget/index.ts";

interface DigestCache {
  lastSeq: number;
  text: string;
  byteLength: number;
  generatedAt: number;
}

const cache = new Map<string, DigestCache>();

export interface DigestOptions {
  lastSeq?: number;
}

export interface ReferenceDigestOptions extends DigestOptions {
  /** Return every CRITICAL note so a missing visible message can be rebuilt. */
  includeAllCritical?: boolean;
}

export interface DigestResult {
  text: string;
  lastSeq: number;
  byteLength: number;
}

export interface ReferenceDigestResult extends DigestResult {
  criticalNotes: Note[];
  cursorReset: boolean;
}

/**
 * Oversized note bodies never enter the automatic feed verbatim (ADR-0030).
 * The stub is explicit and deterministic: it declares the withheld byte count
 * and the sha256 of the complete body, which stays retrievable on disk.
 */
export function inlineNoteBody(content: string): string {
  const cap = boundedIntEnv("PI_BOARD_INLINE_NOTE_MAX_BYTES", 32768);
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes <= cap) return content;
  const digest = createHash("sha256").update(content, "utf-8").digest("hex");
  return `[note body withheld from feed: ${bytes} bytes, sha256=${digest}; retrieve via board action=read on the enclosing Board topic, or .pi-board/topics/<id>.jsonl (open) / .pi-board/topics/archive/<id>.jsonl (closed)]`;
}

function formatNote(note: Note): string {
  const markers: string[] = [];
  if (note.tags?.includes("plan")) markers.push("PLAN");
  if (note.priority === "critical") markers.push("CRITICAL");
  const marker = markers.length > 0 ? `[${markers.join("][")}] ` : "";
  // Author is user-controlled display metadata. Bound it independently so one
  // malicious label cannot consume a whole reference before body safeguards run.
  const author = boundedExcerpt(note.author, boundedIntEnv("PI_BOARD_AUTHOR_EXCERPT_BYTES", 240));
  return `${marker}#${note.seq} ${author}: ${inlineNoteBody(note.content)}`;
}

function formatCompleteDigest(notes: Note[]): string {
  const planNotes = notes.filter(n => n.tags?.includes("plan"));
  const latestPlan = planNotes.at(-1);
  const pinned = [
    ...(latestPlan ? [latestPlan] : []),
    ...notes.filter(n => n.priority === "critical" && n !== latestPlan),
  ];
  const pinnedSet = new Set(pinned);
  const remaining = notes.filter(n => !pinnedSet.has(n));

  const sections: string[] = [];
  if (pinned.length > 0) sections.push(pinned.map(formatNote).join("\n"));
  if (remaining.length > 0) sections.push(remaining.map(formatNote).join("\n"));
  return sections.join("\n---\n").trim();
}

/**
 * Build a complete topic digest. Latest plan and critical notes are pinned,
 * while every other note remains present exactly once (ADR-0012).
 */
export function generateDigest(topicId: string, opts: DigestOptions = {}): DigestResult {
  const since = opts.lastSeq;
  const notes = readNotes(topicId, since);

  if (notes.length === 0) {
    return { text: "", lastSeq: since ?? 0, byteLength: 0 };
  }

  const currentLastSeq = notes[notes.length - 1].seq;
  const cached = cache.get(topicId);
  if (cached && cached.lastSeq === currentLastSeq && since === undefined) {
    return { text: cached.text, lastSeq: cached.lastSeq, byteLength: cached.byteLength };
  }

  const text = formatCompleteDigest(notes);

  const result: DigestResult = {
    text,
    lastSeq: currentLastSeq,
    byteLength: Buffer.byteLength(text, "utf-8"),
  };
  if (since === undefined) {
    cache.set(topicId, { ...result, generatedAt: Date.now() });
  }
  return result;
}

/**
 * Separate visible steering from passive reference context. Every non-critical
 * note remains in the reference digest exactly once; critical notes are returned
 * verbatim for a persistent, operator-visible message (ADR-0013).
 */
export function generateReferenceDigest(
  topicId: string,
  opts: ReferenceDigestOptions = {},
): ReferenceDigestResult {
  // readNotes already parses the complete append-only JSONL before applying
  // `since`; retain that complete set for CRITICAL recovery at no extra I/O.
  return generateReferenceDigestFromNotes(readNotes(topicId), opts);
}

/** Build the same reference digest from an already captured active/archive note set. */
export function generateReferenceDigestFromNotes(
  allNotes: Note[],
  opts: ReferenceDigestOptions = {},
): ReferenceDigestResult {
  const currentLastSeq = allNotes.at(-1)?.seq ?? 0;
  const cursorReset = opts.lastSeq !== undefined && opts.lastSeq > currentLastSeq;
  const notes = opts.lastSeq === undefined || cursorReset
    ? allNotes
    : allNotes.filter(note => note.seq > opts.lastSeq!);
  if (notes.length === 0) {
    return {
      text: "",
      lastSeq: currentLastSeq,
      byteLength: 0,
      cursorReset,
      criticalNotes: opts.includeAllCritical
        ? allNotes.filter(note => note.priority === "critical")
        : [],
    };
  }

  const criticalNotes = (opts.includeAllCritical ? allNotes : notes)
    .filter(note => note.priority === "critical");
  const referenceNotes = notes.filter(note => note.priority !== "critical");
  const text = formatCompleteDigest(referenceNotes);
  return {
    text,
    lastSeq: notes.at(-1)!.seq,
    byteLength: Buffer.byteLength(text, "utf-8"),
    criticalNotes,
    cursorReset,
  };
}

export function invalidateDigestCache(topicId: string): void {
  cache.delete(topicId);
}

export function clearDigestCache(): void {
  cache.clear();
}
