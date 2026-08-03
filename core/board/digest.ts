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

export type DigestStrategy = "auto" | "full" | "recent-only" | "convergence-focused";

export interface DigestOptions {
  lastSeq?: number;
  maxBytes?: number; // 默认 3000
  strategy?: DigestStrategy;
  // auto = 阶段感知逻辑（默认）：根据 note 数量自动调整
  // full = 初期风格，尽量全量包含
  // recent-only = 只最近 3 条 + critical/plan
  // convergence-focused = 只 convergence + critical + plan tags
}

export interface DigestResult {
  text: string;
  lastSeq: number;
  byteLength: number;
}

/**
 * Select candidate notes based on digest strategy and topic phase.
 * Phase-aware logic ("auto") adjusts scope by note volume.
 */
function selectCandidates(
  nonCritical: Note[],
  allNotes: Note[],
  strategy: DigestStrategy,
  totalNotes: number,
): Note[] {
  switch (strategy) {
    case "full":
      // Include all non-critical notes (budget will naturally trim)
      return nonCritical;

    case "recent-only":
      // Only the most recent 3 non-critical notes
      return nonCritical.slice(-3);

    case "convergence-focused":
      // Only notes tagged convergence (+ critical/plan handled separately)
      return nonCritical.filter(n => n.tags?.includes("convergence"));

    case "auto":
    default:
      // Phase-aware: adjust based on topic maturity
      if (totalNotes <= 3) {
        // Early exploration: full context matters
        return nonCritical;
      } else if (totalNotes <= 10) {
        // Mid analysis: recent 5 full + older trimmed by budget
        return nonCritical;
      } else {
        // Convergence phase: only recent 3 + convergence-tagged notes
        const recent = nonCritical.slice(-3);
        const convergence = nonCritical.slice(0, -3).filter(
          n => n.tags?.includes("convergence")
        );
        return [...convergence, ...recent];
      }
  }
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

  // Determine effective strategy
  const strategy = opts.strategy ?? "auto";
  const totalNotes = notes.length;

  // Generate digest with budget
  // 0. Latest plan note: 无条件置顶（取 seq 最大的一条）
  const planNotes = notes.filter(n => n.tags?.includes("plan"));
  const latestPlan = planNotes.length > 0 ? planNotes[planNotes.length - 1] : null;

  // 1. Human critical notes: 无条件置顶，不受预算限制
  const critical = notes.filter(n => n.priority === "critical");
  const nonCritical = notes.filter(n => n.priority !== "critical" && n !== latestPlan);

  let digest = "";

  // Plan note first (unbudgeted, latest version only)
  if (latestPlan) {
    digest += `[PLAN] ${latestPlan.author}: ${latestPlan.content}\n`;
  }

  // Critical notes always included (unbudgeted)
  if (critical.length > 0) {
    for (const n of critical) {
      digest += `[CRITICAL] ${n.author}: ${n.content}\n`;
    }
    digest += "---\n";
  }

  // Budget for non-critical: maxBytes minus what critical consumed
  let budget = maxBytes - Buffer.byteLength(digest, "utf-8");

  // Select candidates based on strategy
  const candidates = selectCandidates(nonCritical, notes, strategy, totalNotes);

  // 2. Recent notes first (reverse chronological)
  const reversed = [...candidates].reverse();
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
