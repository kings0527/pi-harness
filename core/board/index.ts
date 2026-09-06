import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { getStorageRoot, ensureDir } from "../storage/index.ts";
import { appendEvent } from "../events/index.ts";
import { assertArchivedTopicIntact, validateNoteSeq, validateNoteShape, validateTopicShape } from "./integrity.ts";
import type {
  BoardActor,
  CloseReadiness,
  Note,
  NoteKind,
  NoteRef,
  Topic,
  TopicCatalogEntry,
  TopicMeta,
  TopicRelation,
  WitnessKind,
} from "./types.ts";

export interface OpenTopicOptions {
  actor?: BoardActor;
  relations?: TopicRelation[];
}

export interface PostNoteOptions {
  tags?: string[];
  priority?: "critical";
  actor?: BoardActor;
  kind?: NoteKind;
  targets?: NoteRef[];
  relations?: TopicRelation[];
  material?: boolean;
  verdict?: string;
  unresolved?: NoteRef[];
}

interface LockRecord {
  version: 1;
  pid: number;
  processStart: string | null;
  /** Random capability prevents an old owner from releasing a replacement. */
  token: string;
  acquiredAt: number;
}

interface CloseJournal {
  version: 1;
  topicId: string;
  token: string;
  activeJsonl: string;
  activeBoardMd: string;
  archiveJsonl: string;
  archiveBoardMd: string;
  archiveSummary: string;
  archiveDecisions: string;
  closedMeta: Topic;
  summary: string;
  decisions: string;
  phase: "prepared" | "jsonl-committed" | "complete";
}

function topicsDir(): string { return join(getStorageRoot(), "topics"); }
function assertTopicId(topicId: string): void {
  if (typeof topicId !== "string" || topicId.length === 0 || /[\\/\0]/.test(topicId)) {
    throw new Error("Topic ID must be one non-empty path segment");
  }
}
function topicJsonlPath(topicId: string): string { assertTopicId(topicId); return join(topicsDir(), `${topicId}.jsonl`); }
function topicBoardMdPath(topicId: string): string { assertTopicId(topicId); return join(topicsDir(), `${topicId}.board.md`); }
function archivedTopicJsonlPath(topicId: string): string { assertTopicId(topicId); return join(topicsDir(), "archive", `${topicId}.jsonl`); }
function lockPath(topicId: string): string { return `${topicJsonlPath(topicId)}.lock`; }
function journalPath(topicId: string): string { return join(topicsDir(), ".transactions", `${topicId}.close.json`); }

/** Detect the legacy persisted shape where this ID was closed before reuse. */
export function hasArchivedTopic(topicId: string): boolean { return existsSync(archivedTopicJsonlPath(topicId)); }

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function processStartIdentity(pid: number): string | null {
  // Linux start ticks make PID reuse distinguishable. Other supported local
  // filesystems retain the token fence and refuse automatic stale reclamation.
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf-8").trim().split(" ");
    return fields[21] ? `linux-start:${fields[21]}` : null;
  } catch { return null; }
}

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed = JSON.parse(raw) as LockRecord;
    if (parsed?.version === 1 && Number.isInteger(parsed.pid) && typeof parsed.token === "string") return parsed;
  } catch { /* fall through to legacy PID shape */ }
  // Pre-ADR-0029 locks contained only a PID. Do not treat an alive legacy
  // process as stale; an ESRCH PID can still be safely reclaimed.
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0
    ? { version: 1, pid, processStart: null, token: `legacy:${raw.trim()}`, acquiredAt: 0 }
    : null;
}

function readLock(topicId: string): LockRecord | null {
  try { return parseLockRecord(readFileSync(lockPath(topicId), "utf-8")); }
  catch { return null; }
}

function ownerIsProvablyDead(lock: LockRecord): boolean {
  // We reclaim only when a local OS liveness probe says ESRCH, or Linux proves
  // PID reuse through a different start identity. Timeout is deliberately NOT
  // authority to steal a lock (ADR-0029).
  try {
    process.kill(lock.pid, 0);
  } catch (error: any) {
    return error?.code === "ESRCH";
  }
  if (lock.processStart?.startsWith("linux-start:")) {
    const current = processStartIdentity(lock.pid);
    return current !== null && current !== lock.processStart;
  }
  return false;
}

function reclaimProvablyDeadLock(topicId: string): boolean {
  const path = lockPath(topicId);
  const observed = readLock(topicId);
  if (!observed || !ownerIsProvablyDead(observed)) return false;

  // Do not rename the live lock entry: rename creates a vacant pathname and a
  // later "restore" can overwrite a third writer. A hard-link claim observes
  // the current inode while leaving the pathname continuously occupied. Only a
  // token-identical, still-dead inode may then be unlinked; cooperative writers
  // can never acquire it in that interval.
  const claim = `${path}.reclaim.${process.pid}.${randomUUID()}`;
  try { linkSync(path, claim); } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST") return false;
    throw error;
  }
  try {
    const claimed = parseLockRecord(readFileSync(claim, "utf-8"));
    const stillObserved = claimed?.version === 1
      && claimed.token === observed.token
      && ownerIsProvablyDead(claimed);
    const current = readLock(topicId);
    if (!stillObserved || current?.token !== observed.token) return false;
    try {
      unlinkSync(path);
      return true;
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  } finally {
    try { unlinkSync(claim); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
}

function acquireLock(topicId: string, timeoutMs = 5000): LockRecord | null {
  const path = lockPath(topicId);
  const start = Date.now();
  while (true) {
    const record: LockRecord = {
      version: 1,
      pid: process.pid,
      processStart: processStartIdentity(process.pid),
      token: randomUUID(),
      acquiredAt: Date.now(),
    };
    // Write a complete candidate first, then hard-link it into place. Unlike
    // open("wx") followed by write, a SIGKILL cannot leave an empty/unparseable
    // lock that no future owner can classify or reclaim.
    const candidate = `${path}.candidate.${process.pid}.${record.token}`;
    try {
      writeFileSync(candidate, JSON.stringify(record), { encoding: "utf-8", flag: "wx", mode: 0o600 });
      try {
        linkSync(candidate, path);
        return record;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
      }
    } finally {
      try { unlinkSync(candidate); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    if (reclaimProvablyDeadLock(topicId)) continue;
    if (Date.now() - start >= timeoutMs) return null;
    Atomics.wait(lockWait, 0, 0, 10);
  }
}

function assertLockOwnership(topicId: string, lock: LockRecord): void {
  const actual = readLock(topicId);
  if (!actual || actual.token !== lock.token) {
    throw new Error(`Lost fenced lock ownership for topic "${topicId}"`);
  }
}

function releaseLock(topicId: string, lock: LockRecord): void {
  const path = lockPath(topicId);
  try {
    const actual = readLock(topicId);
    if (!actual || actual.token !== lock.token) return; // A newer owner wins.
    unlinkSync(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function writeDurableTemporary(path: string, content: string): string {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf-8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (unlinkError: any) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
    throw error;
  }
}

/** Replace an existing source atomically after its complete bytes reach disk. */
function atomicWriteFile(path: string, content: string): void {
  const temporary = writeDurableTemporary(path, content);
  try { renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error: any) { if (error?.code !== "ENOENT") throw error; } }
}

/** Publish a new source atomically without ever overwriting a pre-existing path. */
function atomicCreateFile(path: string, content: string): void {
  const temporary = writeDurableTemporary(path, content);
  try { linkSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error: any) { if (error?.code !== "ENOENT") throw error; } }
}

function validateActor(actor: BoardActor | undefined): string | null {
  if (!actor) return null;
  if (typeof actor.id !== "string" || actor.id.trim() === "") return "actor.id is not a non-empty string";
  if (actor.label !== undefined && typeof actor.label !== "string") return "actor.label is not a string";
  if (actor.parentSession !== undefined && typeof actor.parentSession !== "string") return "actor.parentSession is not a string";
  return null;
}
function validateRelations(relations: TopicRelation[] | undefined): string | null {
  if (!relations) return null;
  const allowed = new Set(["supports", "depends-on", "conflicts-with", "duplicate-of", "child-of"]);
  for (const relation of relations) {
    if (!relation || !allowed.has(relation.type) || typeof relation.topic !== "string" || relation.topic.length === 0 || /[\\/\0]/.test(relation.topic)) {
      return "relation is invalid";
    }
  }
  return null;
}
function validateRefs(refs: NoteRef[] | undefined): string | null {
  if (!refs) return null;
  for (const ref of refs) {
    if (!ref || typeof ref.topic !== "string" || ref.topic.length === 0 || /[\\/\0]/.test(ref.topic) || !Number.isInteger(ref.seq) || ref.seq < 1) return "target reference is invalid";
  }
  return null;
}
function isStructuredKind(kind: unknown): kind is NoteKind {
  return ["declare", "plan", "claim", "evidence", "challenge", "verification", "decision", "retraction", "convergence"].includes(String(kind));
}

function validateStructuredNote(note: Note): string | null {
  if (note.actor && validateActor(note.actor)) return validateActor(note.actor);
  if (note.kind !== undefined && !isStructuredKind(note.kind)) return "note kind is invalid";
  if (note.targets && validateRefs(note.targets)) return validateRefs(note.targets);
  if (note.relations && validateRelations(note.relations)) return validateRelations(note.relations);
  if (note.material !== undefined && typeof note.material !== "boolean") return "material is not boolean";
  if (note.verdict !== undefined && typeof note.verdict !== "string") return "verdict is not a string";
  if (note.unresolved && validateRefs(note.unresolved)) return validateRefs(note.unresolved);
  if (note.kind && !note.actor) return "structured note requires runtime actor";
  if (note.kind === "claim" && note.material && (!note.targets || note.targets.length === 0)) {
    // A material claim needs no upstream target; it is itself the tracked root.
  }
  if (["challenge", "verification", "retraction"].includes(note.kind ?? "") && (!note.targets || note.targets.length === 0)) {
    return `${note.kind} requires at least one target`;
  }
  if (note.kind === "convergence" && (!note.verdict || !note.actor)) return "convergence requires actor and verdict";
  return null;
}

function readActiveTopic(topicId: string): { topic: Topic; notes: Note[] } {
  recoverCloseTransaction(topicId);
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(l => l.trim());
  if (!lines[0]?.startsWith("#META#")) throw new Error(`Topic "${topicId}" JSONL is corrupted: missing META line`);
  let topic: Topic;
  try { topic = JSON.parse(lines[0].slice(6)) as Topic; } catch { throw new Error(`Topic "${topicId}" JSONL is corrupted: META line is not valid JSON`); }
  const topicShapeIssue = validateTopicShape(topic);
  if (topicShapeIssue) throw new Error(`Topic "${topicId}" JSONL is corrupted: META shape invalid: ${topicShapeIssue}`);
  if (topic.id !== topicId || topic.status !== "open") throw new Error(`Topic "${topicId}" JSONL is corrupted: META identity/status mismatch (${topic.id}/${topic.status})`);
  if (validateActor(topic.createdBy)) throw new Error(`Topic "${topicId}" JSONL is corrupted: ${validateActor(topic.createdBy)}`);
  if (validateRelations(topic.relations)) throw new Error(`Topic "${topicId}" JSONL is corrupted: ${validateRelations(topic.relations)}`);
  const notes: Note[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    let note: Note;
    try { note = JSON.parse(lines[i]) as Note; } catch { throw new Error(`Topic "${topicId}" JSONL is corrupted: line ${i + 1} is not valid JSON`); }
    const shapeIssue = validateNoteShape(note);
    if (shapeIssue) throw new Error(`Topic "${topicId}" JSONL is corrupted: line ${i + 1} shape invalid: ${shapeIssue}`);
    const structuredIssue = validateStructuredNote(note);
    if (structuredIssue) throw new Error(`Topic "${topicId}" JSONL is corrupted: line ${i + 1} ${structuredIssue}`);
    notes.push(note);
  }
  const seqIssues = validateNoteSeq(notes);
  if (seqIssues.length > 0) throw new Error(`Topic "${topicId}" JSONL is corrupted (seq gap/rollback — external rewrite or Git conflict?): ${seqIssues.join("; ")}`);
  return { topic, notes };
}

function readAnyTopic(topicId: string): { topic: Topic; notes: Note[] } {
  // A malformed live topic must fail loud; never silently route a target to an
  // older archive with the same ID. Archive lookup is only valid when no live
  // JSONL exists at all.
  if (existsSync(topicJsonlPath(topicId))) return readActiveTopic(topicId);
  if (existsSync(archivedTopicJsonlPath(topicId))) {
    const archived = readArchivedTopic(topicId);
    return { topic: archived.topic, notes: archived.notes };
  }
  throw new Error(`Topic "${topicId}" not found`);
}

function validateTargets(topicId: string, topic: Topic, notes: Note[], note: Note): void {
  // `unresolved` is part of a convergence verdict, not prose: validate it
  // against the same append-only/relation boundary as ordinary targets.
  const targets = note.targets ?? [];
  const refs = [...targets, ...(note.unresolved ?? [])];
  for (const target of refs) {
    if (target.topic !== topicId) {
      const declared = [...(topic.relations ?? []), ...notes.flatMap(candidate => candidate.relations ?? []), ...(note.relations ?? [])]
        .some(relation => relation.topic === target.topic);
      if (!declared) throw new Error(`Cross-topic target ${target.topic} requires a declared relation`);
    }
    const targetRecord = target.topic === topicId
      ? notes.find(candidate => candidate.seq === target.seq)
      : readAnyTopic(target.topic).notes.find(candidate => candidate.seq === target.seq);
    if (!targetRecord) throw new Error(`Note target ${target.topic}#${target.seq} does not exist`);
    // Kind semantics apply only to explicit action targets. An unresolved
    // convergence reference may honestly point at a claim or a challenge.
    if (!targets.some(ref => ref.topic === target.topic && ref.seq === target.seq)) continue;
    if (note.kind === "challenge" && !["claim", "evidence", "decision"].includes(targetRecord.kind ?? "")) throw new Error("challenge target must be claim, evidence, or decision");
    if (note.kind === "verification" && targetRecord.kind !== "claim") throw new Error("verification target must be claim");
  }
}

/** A topic id is an append-only Board identity. */
export function openTopic(topicId: string, goal: string, opts: OpenTopicOptions = {}): Topic {
  const jsonlPath = topicJsonlPath(topicId);
  const lock = acquireLock(topicId);
  if (!lock) throw new Error(`Failed to acquire lock for topic "${topicId}" (timeout; existing owner was not provably dead)`);
  try {
    assertLockOwnership(topicId, lock);
    if (hasArchivedTopic(topicId)) throw new Error(`Topic "${topicId}" already exists in archive`);
    const actorIssue = validateActor(opts.actor); if (actorIssue) throw new Error(`Topic rejected before write: ${actorIssue}`);
    const relationsIssue = validateRelations(opts.relations); if (relationsIssue) throw new Error(`Topic rejected before write: ${relationsIssue}`);
    const topic: Topic = { id: topicId, goal, status: "open", createdAt: Date.now(), ...(opts.actor && { createdBy: opts.actor }), ...(opts.relations && { relations: opts.relations }) };
    const shapeIssue = validateTopicShape(topic); if (shapeIssue) throw new Error(`Topic "${topicId}" rejected before write: ${shapeIssue}`);
    try { atomicCreateFile(jsonlPath, `#META#${JSON.stringify(topic)}\n`); }
    catch (error: any) { if (error?.code === "EEXIST") throw new Error(`Topic "${topicId}" already exists`); throw error; }
    assertLockOwnership(topicId, lock);
    renderBoardMd(topicId, topic, []);
    appendEvent("board_open", {
      topic: topicId,
      goalBytes: Buffer.byteLength(goal, "utf-8"),
      goalDigest: createHash("sha256").update(goal, "utf-8").digest("hex"),
      actorId: opts.actor?.id,
    });
    return topic;
  } finally { releaseLock(topicId, lock); }
}

export function postNote(topicId: string, author: string, content: string, opts: PostNoteOptions = {}): Note {
  const jsonlPath = topicJsonlPath(topicId);
  if (!existsSync(jsonlPath)) throw new Error(`Topic "${topicId}" not found`);
  // Recover a dead predecessor before claiming the next writer lock. Once we
  // own a lock, recovery deliberately refuses to interfere with ourselves.
  recoverCloseTransaction(topicId);
  const lock = acquireLock(topicId);
  if (!lock) throw new Error(`Failed to acquire lock for topic "${topicId}" (timeout; existing owner was not provably dead)`);
  try {
    assertLockOwnership(topicId, lock);
    const { topic, notes } = readActiveTopic(topicId);
    const seq = notes.length > 0 ? notes[notes.length - 1].seq + 1 : 1;
    const note: Note = { seq, author, timestamp: Date.now(), content,
      ...(opts.tags && { tags: opts.tags }), ...(opts.priority && { priority: opts.priority }),
      ...(opts.actor && { actor: opts.actor }), ...(opts.kind && { kind: opts.kind }),
      ...(opts.targets && { targets: opts.targets }), ...(opts.relations && { relations: opts.relations }),
      ...(opts.material !== undefined && { material: opts.material }), ...(opts.verdict && { verdict: opts.verdict }),
      ...(opts.unresolved && { unresolved: opts.unresolved }),
    };
    const shapeIssue = validateNoteShape(note); if (shapeIssue) throw new Error(`Note rejected before write on topic "${topicId}": ${shapeIssue}`);
    const structuredIssue = validateStructuredNote(note); if (structuredIssue) throw new Error(`Note rejected before write on topic "${topicId}": ${structuredIssue}`);
    validateTargets(topicId, topic, notes, note);
    assertLockOwnership(topicId, lock);
    appendFileSync(jsonlPath, JSON.stringify(note) + "\n", "utf-8");
    const after = readActiveTopic(topicId);
    const persisted = after.notes.at(-1);
    if (after.notes.length !== notes.length + 1 || JSON.stringify(persisted) !== JSON.stringify(note)) throw new Error(`Topic "${topicId}" append verification failed: note #${seq} not persisted intact`);
    assertLockOwnership(topicId, lock);
    renderBoardMd(topicId, after.topic, after.notes);
    appendEvent("board_post", { topic: topicId, seq, author, actorId: opts.actor?.id, kind: opts.kind });
    return note;
  } finally { releaseLock(topicId, lock); }
}

export function readNotes(topicId: string, since?: number): Note[] {
  recoverBoardTransactions();
  const { notes } = readActiveTopic(topicId);
  return since === undefined ? notes : notes.filter(note => note.seq > since);
}

export function readArchivedTopic(topicId: string): { topic: Topic; notes: Note[]; integrity: WitnessKind } {
  recoverCloseTransaction(topicId);
  const report = assertArchivedTopicIntact(topicId);
  const jsonlPath = archivedTopicJsonlPath(topicId);
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(line => line.trim());
  const metaLine = lines[0];
  if (!metaLine?.startsWith("#META#")) throw new Error(`Invalid archived topic file: missing META line for "${topicId}"`);
  const topic = JSON.parse(metaLine.slice(6)) as Topic;
  if (topic.id !== topicId || topic.status !== "closed") throw new Error(`Invalid archived topic identity or status for "${topicId}"`);
  if (validateActor(topic.createdBy) || validateActor(topic.closedBy) || validateRelations(topic.relations)) {
    throw new Error(`Invalid archived topic metadata for "${topicId}"`);
  }
  const notes = lines.slice(1).map(line => JSON.parse(line) as Note);
  for (const note of notes) {
    const issue = validateStructuredNote(note);
    if (issue) throw new Error(`Invalid archived topic "${topicId}": ${issue}`);
  }
  return { topic, notes, integrity: report.witnessKind };
}

export function listTopics(): TopicMeta[] {
  recoverBoardTransactions();
  const dir = topicsDir();
  const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
  const topics: TopicMeta[] = [];
  for (const file of files) { const topicId = file.replace(".jsonl", ""); const { topic, notes } = readActiveTopic(topicId); topics.push({ ...topic, noteCount: notes.length }); }
  const archiveDir = join(dir, "archive");
  if (existsSync(archiveDir)) for (const file of readdirSync(archiveDir).filter(f => f.endsWith(".jsonl"))) {
    const topicId = file.replace(".jsonl", ""); const archived = readArchivedTopic(topicId);
    topics.push({ ...archived.topic, noteCount: archived.notes.length, integrity: archived.integrity });
  }
  return topics;
}

export function listOpenTopics(): Topic[] {
  recoverBoardTransactions();
  const files = readdirSync(topicsDir()).filter(file => file.endsWith(".jsonl"));
  const topics: Topic[] = [];
  for (const file of files) { const topicId = file.slice(0, -".jsonl".length); try { topics.push(readActiveTopic(topicId).topic); } catch (error: any) { if (error?.code !== "ENOENT") throw error; } }
  return topics;
}

function catalogEntry(topic: Topic, notes: Note[], integrity?: WitnessKind): TopicCatalogEntry {
  const critical = notes.filter(note => note.priority === "critical");
  const participants = [...new Set([topic.createdBy?.id, ...notes.map(note => note.actor?.id)].filter((value): value is string => Boolean(value)))].sort();
  const relations = [...(topic.relations ?? []), ...notes.flatMap(note => note.relations ?? [])];
  return {
    ...topic,
    noteCount: notes.length,
    ...(integrity && { integrity }),
    lastActivityAt: notes.at(-1)?.timestamp ?? topic.createdAt,
    lastSeq: notes.at(-1)?.seq ?? 0,
    criticalCount: critical.length,
    ...(critical.at(-1) && { lastCriticalSeq: critical.at(-1)!.seq }),
    participants,
    relations,
  };
}

/** Metadata for open topics only; the hot discovery path never scans archives. */
export function listOpenTopicCatalog(): TopicCatalogEntry[] {
  recoverBoardTransactions();
  return listOpenTopics().map(topic => {
    const { notes } = readActiveTopic(topic.id);
    return catalogEntry(topic, notes);
  }).sort((left, right) => left.id.localeCompare(right.id));
}

export function getTopicCatalogEntry(topicId: string): TopicCatalogEntry {
  recoverBoardTransactions();
  if (existsSync(topicJsonlPath(topicId))) {
    const { topic, notes } = readActiveTopic(topicId);
    return catalogEntry(topic, notes);
  }
  const archived = readArchivedTopic(topicId);
  return catalogEntry(archived.topic, archived.notes, archived.integrity);
}

export function listTopicCatalog(): TopicCatalogEntry[] {
  return listTopics().map(meta => getTopicCatalogEntry(meta.id))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function refKey(ref: NoteRef): string { return `${ref.topic}#${ref.seq}`; }
function noteRef(topic: string, note: Note): NoteRef { return { topic, seq: note.seq }; }

/** Active local notes after append-only retractions are applied from newest to oldest. */
function activeNotes(topicId: string, notes: Note[]): Note[] {
  const retracted = new Set<string>();
  const active: Note[] = [];
  for (const note of [...notes].reverse()) {
    const ref = refKey(noteRef(topicId, note));
    if (retracted.has(ref)) continue;
    active.push(note);
    if (note.kind === "retraction") {
      for (const target of note.targets ?? []) retracted.add(refKey(target));
    }
  }
  return active.reverse();
}

function targetRecord(topicId: string, localNotes: Note[], target: NoteRef): Note | undefined {
  if (target.topic === topicId) return activeNotes(topicId, localNotes).find(note => note.seq === target.seq);
  const remote = readAnyTopic(target.topic).notes;
  return activeNotes(target.topic, remote).find(note => note.seq === target.seq);
}

/**
 * Evaluate only graph facts, never prose truth: a material claim needs an
 * active verification, an active retraction, or a later convergence that names
 * it as explicitly accepted unresolved. Challenges against material claims use
 * the same append-only state, including declared cross-topic targets.
 */
export function assessCloseReadiness(topicId: string): CloseReadiness {
  const { topic, notes } = readActiveTopic(topicId);
  const active = activeNotes(topicId, notes);
  const convergence = [...active].reverse().find(note => note.kind === "convergence" && note.actor);
  const materialClaims = active.filter(note => note.kind === "claim" && note.material);
  const materialClaimKeys = new Set(materialClaims.map(note => refKey(noteRef(topicId, note))));
  const activeChallenges: Array<{ note: Note; ref: NoteRef; originTopic: string }> = [];

  // A declared cross-topic challenge belongs to the challenged claim's close
  // boundary, not merely to the challenger topic. Include closed challenger
  // topics too: closure does not retract an append-only challenge, and omitting
  // archives would let a challenger disappear simply by closing its own topic.
  // A later decision/retraction or explicit unresolved acceptance remains the
  // target topic's way to resolve that incoming objection.
  const challengeStreams: Array<{ topic: string; notes: Note[] }> = [{ topic: topicId, notes }];
  for (const candidate of listTopics()) {
    if (candidate.id === topicId) continue;
    challengeStreams.push({ topic: candidate.id, notes: readAnyTopic(candidate.id).notes });
  }
  for (const stream of challengeStreams) {
    for (const challenge of activeNotes(stream.topic, stream.notes).filter(note => note.kind === "challenge")) {
      if ((challenge.targets ?? []).some(target => materialClaimKeys.has(refKey(target)))) {
        activeChallenges.push({ note: challenge, ref: noteRef(stream.topic, challenge), originTopic: stream.topic });
      }
    }
  }

  const accepted = new Set<string>(convergence?.unresolved?.map(refKey) ?? []);
  const verifiedAt = new Map<string, number>();
  const decidedAt = new Map<string, number>();
  for (const note of active) {
    if (note.kind === "verification") for (const target of note.targets ?? []) verifiedAt.set(refKey(target), note.seq);
    if (note.kind === "decision") for (const target of note.targets ?? []) decidedAt.set(refKey(target), note.seq);
  }

  // A valid convergence is a terminal statement. Work or a resolution posted
  // after it requires a later convergence; an earlier verdict cannot decide
  // facts that did not yet exist in the append-only graph.
  const convergenceSeq = convergence?.seq ?? -1;
  const openMaterialClaims = materialClaims
    .filter(note => note.seq > convergenceSeq
      || ((verifiedAt.get(refKey(noteRef(topicId, note))) ?? Infinity) > convergenceSeq
        && !accepted.has(refKey(noteRef(topicId, note)))))
    .map(note => noteRef(topicId, note));
  const openChallenges = activeChallenges
    .filter(({ note, ref, originTopic }) => {
      if (accepted.has(refKey(ref))) return false;
      const decisionSeq = decidedAt.get(refKey(ref));
      // A foreign topic's seq is not comparable with this topic's convergence
      // seq. Require a local decision targeting that foreign challenge before
      // convergence (or list it explicitly unresolved); otherwise it remains
      // an incoming unresolved objection to this material claim.
      if (originTopic !== topicId) return decisionSeq === undefined || decisionSeq > convergenceSeq;
      return note.seq > convergenceSeq || decisionSeq === undefined || decisionSeq > convergenceSeq;
    })
    .map(({ ref }) => ref);

  if (!convergence) return { ready: false, reason: "no structured convergence verdict", openMaterialClaims, openChallenges };
  if (openMaterialClaims.length > 0) {
    return { ready: false, reason: "open material claims lack active verification or explicit unresolved acceptance", convergence, openMaterialClaims, openChallenges };
  }
  if (openChallenges.length > 0) {
    return { ready: false, reason: "open material-claim challenges", convergence, openMaterialClaims, openChallenges };
  }
  // A new actor-created topic is structured even if its first note was
  // free-form; legacy topics have neither createdBy nor structured notes.
  if (!topic.createdBy && !notes.some(note => note.kind !== undefined)) {
    return { ready: true, convergence: undefined, openMaterialClaims: [], openChallenges: [] };
  }
  return { ready: true, convergence, openMaterialClaims: [], openChallenges: [] };
}

export function closeTopic(topicId: string, opts: { actor?: BoardActor } = {}): { summary: string; decisions: string } {
  // Same pre-acquisition recovery rule as post: stale close journals must be
  // resolved before a new closer becomes the live fenced owner.
  recoverCloseTransaction(topicId);
  const lock = acquireLock(topicId);
  if (!lock) throw new Error(`Failed to acquire lock for topic "${topicId}" (timeout; existing owner was not provably dead)`);
  try {
    assertLockOwnership(topicId, lock);
    const { topic, notes } = readActiveTopic(topicId);
    // Only a truly legacy topic (no runtime creator and no structured notes)
    // keeps the old tag-based close convention. A new actor-created topic
    // cannot bypass the graph with a free-form tags=["convergence"] note.
    const legacy = !topic.createdBy && !notes.some(note => note.kind !== undefined);
    const readiness = assessCloseReadiness(topicId);
    if (!legacy && !readiness.ready) throw new Error(`Board close blocked: ${readiness.reason}`);
    const actorIssue = validateActor(opts.actor); if (actorIssue) throw new Error(`Board close rejected: ${actorIssue}`);
    const summary = generateSummary(topic, notes); const decisions = generateDecisions(topic, notes);
    const archiveDir = join(topicsDir(), "archive"); ensureDir(archiveDir); ensureDir(join(topicsDir(), ".transactions"));
    const activeJsonl = topicJsonlPath(topicId); const activeBoardMd = topicBoardMdPath(topicId);
    const archiveJsonl = archivedTopicJsonlPath(topicId); const archiveBoardMd = join(archiveDir, `${topicId}.board.md`);
    const archiveSummary = join(archiveDir, `${topicId}.summary.md`); const archiveDecisions = join(archiveDir, `${topicId}.decisions.md`);
    const collisions = [archiveJsonl, archiveBoardMd, archiveSummary, archiveDecisions].filter(existsSync);
    if (collisions.length > 0) throw new Error(`Archive collision for topic "${topicId}"; active topic was preserved (${collisions.length} existing artifact${collisions.length === 1 ? "" : "s"})`);
    const closedMeta: Topic = { ...topic, status: "closed", closedAt: Date.now(), ...(opts.actor && { closedBy: opts.actor }), integrityVersion: 1, finalSeq: notes.length };
    const journal: CloseJournal = { version: 1, topicId, token: lock.token, activeJsonl, activeBoardMd, archiveJsonl, archiveBoardMd, archiveSummary, archiveDecisions, closedMeta, summary, decisions, phase: "prepared" };
    atomicCreateFile(journalPath(topicId), JSON.stringify(journal));
    assertLockOwnership(topicId, lock);
    const lines = readFileSync(activeJsonl, "utf-8").split("\n");
    lines[0] = `#META#${JSON.stringify(closedMeta)}`;
    atomicWriteFile(activeJsonl, lines.join("\n"));
    renameSync(activeJsonl, archiveJsonl);
    journal.phase = "jsonl-committed";
    atomicWriteFile(journalPath(topicId), JSON.stringify(journal));
    finalizeCloseJournal(journal);
    assertLockOwnership(topicId, lock);
    appendEvent("board_close", { topic: topicId, actorId: opts.actor?.id });
    return { summary, decisions };
  } finally { releaseLock(topicId, lock); }
}

function parseRecoverableTopicFile(topicId: string, path: string, statuses: readonly ("open" | "closed")[]): { topic: Topic; notes: Note[] } {
  const lines = readFileSync(path, "utf-8").split("\n").filter(line => line.trim());
  if (!lines[0]?.startsWith("#META#")) throw new Error(`Close recovery for "${topicId}" has invalid source META; journal preserved`);
  let topic: Topic;
  try { topic = JSON.parse(lines[0].slice(6)) as Topic; }
  catch { throw new Error(`Close recovery for "${topicId}" has invalid source META JSON; journal preserved`); }
  if (topic.id !== topicId || !statuses.includes(topic.status) || validateTopicShape(topic)) {
    throw new Error(`Close recovery for "${topicId}" has invalid source identity/status/shape; journal preserved`);
  }
  const notes: Note[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    let note: Note;
    try { note = JSON.parse(lines[index]) as Note; }
    catch { throw new Error(`Close recovery for "${topicId}" has torn note bytes; journal preserved`); }
    if (validateNoteShape(note) || validateStructuredNote(note)) {
      throw new Error(`Close recovery for "${topicId}" has invalid note shape; journal preserved`);
    }
    notes.push(note);
  }
  if (validateNoteSeq(notes).length > 0) throw new Error(`Close recovery for "${topicId}" has non-contiguous notes; journal preserved`);
  return { topic, notes };
}

function finalizeCloseJournal(journal: CloseJournal): void {
  ensureDir(join(topicsDir(), "archive"));
  if (!existsSync(journal.archiveJsonl)) throw new Error(`Close recovery for "${journal.topicId}" lacks archive JSONL after commit point`);
  if (existsSync(journal.activeBoardMd) && !existsSync(journal.archiveBoardMd)) renameSync(journal.activeBoardMd, journal.archiveBoardMd);
  if (!existsSync(journal.archiveBoardMd)) {
    // A crash may occur after archive JSONL commit but before moving the
    // derived view. Recreate only that derivable artifact from the immutable
    // commit point; never pretend a missing source JSONL is recoverable.
    const archived = parseRecoverableTopicFile(journal.topicId, journal.archiveJsonl, ["closed"]);
    writeBoardMd(journal.archiveBoardMd, journal.topicId, archived.topic, archived.notes);
  }
  if (!existsSync(journal.archiveSummary)) atomicCreateFile(journal.archiveSummary, journal.summary);
  if (!existsSync(journal.archiveDecisions)) atomicCreateFile(journal.archiveDecisions, journal.decisions);
  journal.phase = "complete"; atomicWriteFile(journalPath(journal.topicId), JSON.stringify(journal));
  unlinkSync(journalPath(journal.topicId));
}

/** Deterministic transaction recovery. Once archive JSONL exists it is the only commit point. */
export function recoverCloseTransaction(topicId: string): void {
  const path = journalPath(topicId);
  if (!existsSync(path)) return;
  let journal: CloseJournal;
  try { journal = JSON.parse(readFileSync(path, "utf-8")) as CloseJournal; } catch { throw new Error(`Close recovery journal for "${topicId}" is invalid; evidence preserved`); }
  if (journal.version !== 1 || journal.topicId !== topicId || typeof journal.token !== "string" || journal.token.length === 0) {
    throw new Error(`Close recovery journal for "${topicId}" has invalid identity/token; evidence preserved`);
  }
  const owner = readLock(topicId);
  const currentStart = processStartIdentity(process.pid);
  // A journal describes one fenced close attempt. A different lock token means
  // another writer acquired this topic after that attempt; never let an old
  // recovery transaction mutate its state or erase the journal evidence.
  if (owner && owner.token !== journal.token) {
    throw new Error(`Close recovery journal for "${topicId}" lock token mismatch; evidence preserved`);
  }
  // Never race an in-flight close. A stale journal may only be recovered if no
  // owner exists or its local process identity is provably gone/reused.
  if (owner && owner.pid === process.pid && owner.processStart === currentStart) return;
  if (owner && !ownerIsProvablyDead(owner)) return;
  if (owner && ownerIsProvablyDead(owner) && !reclaimProvablyDeadLock(topicId)) {
    // A competing recovery changed the lock between observation and claim.
    // Leave its fenced owner alone and retry on the next normal access.
    return;
  }
  if (existsSync(journal.archiveJsonl)) { finalizeCloseJournal(journal); return; }
  // Before the archive commit point, active JSONL is authoritative. Validate
  // every byte before changing META or deleting the journal: an old torn write
  // must remain fail-loud *with* its recovery evidence, never be relabelled
  // open and then have the only journal silently discarded.
  if (!existsSync(journal.activeJsonl)) throw new Error(`Close recovery for "${topicId}" has neither active nor archive JSONL; evidence preserved`);
  const source = parseRecoverableTopicFile(topicId, journal.activeJsonl, ["open", "closed"]);
  if (source.topic.status === "closed") {
    const restored = { ...source.topic, status: "open" as const };
    delete restored.closedAt;
    delete restored.closedBy;
    delete restored.integrityVersion;
    delete restored.finalSeq;
    const lines = readFileSync(journal.activeJsonl, "utf-8").split("\n");
    lines[0] = `#META#${JSON.stringify(restored)}`;
    atomicWriteFile(journal.activeJsonl, lines.join("\n"));
  }
  // The restored file must satisfy the normal reader before journal deletion.
  parseRecoverableTopicFile(topicId, journal.activeJsonl, ["open"]);
  unlinkSync(path);
}

function recoverAllCloseTransactions(): void {
  const dir = join(topicsDir(), ".transactions");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter(file => file.endsWith(".close.json"))) recoverCloseTransaction(file.slice(0, -".close.json".length));
}

function recoverOpenTransactions(): void {
  // An interrupted new-topic creation can leave a valid JSONL but no rendered
  // board.md. Rebuild it deterministically; malformed partial JSONL remains a
  // fail-loud integrity error rather than becoming an orphaned catalog entry.
  for (const file of readdirSync(topicsDir()).filter(file => file.endsWith(".jsonl"))) {
    const topicId = file.slice(0, -".jsonl".length);
    const boardPath = topicBoardMdPath(topicId);
    if (existsSync(boardPath)) continue;
    const { topic, notes } = readActiveTopic(topicId);
    renderBoardMd(topicId, topic, notes);
  }
}

function recoverBoardTransactions(): void {
  recoverAllCloseTransactions();
  recoverOpenTransactions();
}

function boardMdContent(topicId: string, topic: Topic, notes: Note[]): string {
  let md = `# Topic: ${topicId}\n\n**Goal**: ${topic.goal}\n**Status**: ${topic.status}\n**Created**: ${new Date(topic.createdAt).toISOString()}\n`;
  if (topic.createdBy) md += `**Created by**: ${topic.createdBy.label ?? topic.createdBy.id} (${topic.createdBy.id})\n`;
  md += "\n---\n\n";
  for (const note of notes) {
    const priorityTag = note.priority === "critical" ? " 🔴 CRITICAL" : ""; const tagsStr = note.tags?.length ? ` [${note.tags.join(", ")}]` : "";
    const kind = note.kind ? ` {${note.kind}${note.material ? ", material" : ""}}` : "";
    const actor = note.actor ? ` (${note.actor.id})` : "";
    md += `### #${note.seq} — ${note.author}${actor}${priorityTag}${tagsStr}${kind}\n*${new Date(note.timestamp).toISOString()}*\n\n${note.content}\n\n`;
  }
  return md;
}

function writeBoardMd(path: string, topicId: string, topic: Topic, notes: Note[]): void {
  atomicWriteFile(path, boardMdContent(topicId, topic, notes));
}

function renderBoardMd(topicId: string, topic: Topic, notes: Note[]): void {
  writeBoardMd(topicBoardMdPath(topicId), topicId, topic, notes);
}

function generateSummary(topic: Topic, notes: Note[]): string {
  let md = `<!-- PI_BOARD_SUMMARY v1 totalNotes=${notes.length} -->\n# Summary: ${topic.id}\n\n**Goal**: ${topic.goal}\n**Duration**: ${new Date(topic.createdAt).toISOString()} → ${new Date(Date.now()).toISOString()}\n**Total Notes**: ${notes.length}\n**Participants**: ${[...new Set(notes.map(n => n.author))].join(", ")}\n\n## Discussion Highlights\n\n`;
  const critical = notes.filter(n => n.priority === "critical"); if (critical.length) { md += "### Critical Notes\n\n"; for (const n of critical) md += `- [#${n.seq}] ${n.author}: ${n.content}\n`; md += "\n"; }
  md += "### Complete Activity\n\n"; for (const n of notes) md += `- [#${n.seq}] ${n.author}: ${n.content}\n`; return md;
}
function generateDecisions(topic: Topic, notes: Note[]): string {
  let md = `# Decisions: ${topic.id}\n\n**Goal**: ${topic.goal}\n\n## Key Findings & Decisions\n\n`;
  for (const n of notes.filter(n => n.priority === "critical")) md += `### Decision from ${n.author} (seq #${n.seq})\n\n${n.content}\n\n`;
  if (notes.length) { const last = notes.at(-1)!; md += `### Final Note (seq #${last.seq}, by ${last.author})\n\n${last.content}\n\n`; }
  return `${md}---\n\n*Generated at topic close. Use \`distill\` to elevate conclusions to knowledge.*\n`;
}
