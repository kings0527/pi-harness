import { readNotes } from "./index.ts";
import type { Note } from "./types.ts";

interface DigestCache {
  lastSeq: number;
  text: string;
  byteLength: number;
  generatedAt: number;
}

// Per-topic cache
const cache = new Map<string, DigestCache>();

export interface DigestOptions {
  lastSeq?: number;
  maxBytes?: number; // 默认 3000
}

export interface DigestResult {
  text: string;
  lastSeq: number;
  byteLength: number;
}

export function generateDigest(topicId: string, opts: DigestOptions = {}): DigestResult {
  const maxBytes = opts.maxBytes ?? 3000;
  const since = opts.lastSeq;

  // Check cache: if last_seq unchanged, reuse
  const cached = cache.get(topicId);

  // Read all notes (or since last seq)
  const notes = readNotes(topicId, since);

  if (notes.length === 0) {
    return { text: "", lastSeq: since ?? 0, byteLength: 0 };
  }

  const currentLastSeq = notes[notes.length - 1].seq;

  // If cache is still valid
  if (cached && cached.lastSeq === currentLastSeq && !since) {
    return { text: cached.text, lastSeq: cached.lastSeq, byteLength: cached.byteLength };
  }

  // Generate digest with budget
  // 1. Human critical notes: 无条件置顶，不受预算限制
  const critical = notes.filter(n => n.priority === "critical");
  const nonCritical = notes.filter(n => n.priority !== "critical");

  let digest = "";

  // Critical notes always included (unbudgeted)
  if (critical.length > 0) {
    for (const n of critical) {
      digest += `[CRITICAL] ${n.author}: ${n.content}\n`;
    }
    digest += "---\n";
  }

  // Budget for non-critical: maxBytes minus what critical consumed
  let budget = maxBytes - Buffer.byteLength(digest, "utf-8");

  // 2. Recent notes first (reverse chronological)
  const reversed = [...nonCritical].reverse();
  const included: string[] = [];

  for (const n of reversed) {
    const line = `#${n.seq} ${n.author}: ${n.content}\n`;
    const lineBytes = Buffer.byteLength(line, "utf-8");

    if (budget - lineBytes >= 0) {
      included.unshift(line); // maintain chronological order
      budget -= lineBytes;
    } else {
      // 3. Older notes: one-line summary
      const remaining = reversed.length - included.length;
      if (remaining > 0) {
        const summaryLine = `... (${remaining} earlier notes omitted)\n`;
        if (budget - Buffer.byteLength(summaryLine, "utf-8") >= 0) {
          included.unshift(summaryLine);
        }
      }
      break;
    }
  }

  digest += included.join("");

  const result: DigestResult = {
    text: digest.trim(),
    lastSeq: currentLastSeq,
    byteLength: Buffer.byteLength(digest, "utf-8"),
  };

  // Update cache
  cache.set(topicId, {
    ...result,
    generatedAt: Date.now(),
  });

  return result;
}

export function invalidateDigestCache(topicId: string): void {
  cache.delete(topicId);
}

export function clearDigestCache(): void {
  cache.clear();
}
