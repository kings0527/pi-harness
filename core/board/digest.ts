import { readNotes } from "./index.ts";
import type { Note } from "./types.ts";

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

export interface DigestResult {
  text: string;
  lastSeq: number;
  byteLength: number;
}

export interface ReferenceDigestResult extends DigestResult {
  criticalNotes: Note[];
}

function formatNote(note: Note): string {
  const markers: string[] = [];
  if (note.tags?.includes("plan")) markers.push("PLAN");
  if (note.priority === "critical") markers.push("CRITICAL");
  const marker = markers.length > 0 ? `[${markers.join("][")}] ` : "";
  return `${marker}#${note.seq} ${note.author}: ${note.content}`;
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
export function generateReferenceDigest(topicId: string): ReferenceDigestResult {
  const notes = readNotes(topicId);
  if (notes.length === 0) {
    return { text: "", lastSeq: 0, byteLength: 0, criticalNotes: [] };
  }

  const criticalNotes = notes.filter(note => note.priority === "critical");
  const referenceNotes = notes.filter(note => note.priority !== "critical");
  const text = formatCompleteDigest(referenceNotes);
  return {
    text,
    lastSeq: notes.at(-1)!.seq,
    byteLength: Buffer.byteLength(text, "utf-8"),
    criticalNotes,
  };
}

export function invalidateDigestCache(topicId: string): void {
  cache.delete(topicId);
}

export function clearDigestCache(): void {
  cache.clear();
}
