import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  generateReferenceDigest,
  generateReferenceDigestFromNotes,
} from "../board/digest.ts";
import { hasArchivedTopic, listOpenTopics, readArchivedTopic } from "../board/index.ts";
import type { Note, Topic } from "../board/types.ts";
import {
  auditIndex,
  getIndex,
  getKnowledgeRoot,
  getProjectRoot,
  getWorkspaceRoot,
  type IndexEntry,
  type KnowledgeIndexIssue,
  type KnowledgeScope,
} from "../knowledge/index.ts";
import { extractRootSections, readScope, type ScopeEntry } from "../knowledge/scope.ts";

export interface KnowledgeSnapshot {
  content: string;
  bytes: number;
  issues: Array<{ scope: KnowledgeScope; issue: KnowledgeIndexIssue }>;
}

export interface CriticalUpdate {
  topic: string;
  goal: string;
  note: Note;
  key: string;
}

export interface BoardSnapshot {
  content: string;
  bytes: number;
  topicSeqs: Record<string, number>;
  topicStates: Record<string, BoardTopicState>;
  topicIncarnations: Record<string, number>;
  criticalUpdates: CriticalUpdate[];
}

export type BoardTopicState = "open" | "closed";

export interface BoardCoverage {
  hasCheckpoint: boolean;
  topicSeqs: Record<string, number>;
  topicStates: Record<string, BoardTopicState>;
  topicIncarnations: Record<string, number>;
}

export interface BoardDelivery extends BoardSnapshot {
  mode: "checkpoint" | "delta" | "none";
  logicalBytes: number;
  resetTopics: string[];
  warnings?: string[];
}

export interface ReferenceContent {
  content: string;
  sourceDigest: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function setTopicValue<T>(record: Record<string, T>, topic: string, value: T): void {
  // Assignment to "__proto__" on a normal object invokes the legacy prototype
  // setter instead of creating cursor metadata. Define an enumerable own data
  // property so every valid one-segment topic ID round-trips through JSON.
  Object.defineProperty(record, topic, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function getTopicValue<T>(record: Record<string, T>, topic: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, topic) ? record[topic] : undefined;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// ADR-0026: the model's primary catalog carries only active rows. Retired
// rows fold into a demoted section (still cite-able for history, never a peer
// of live knowledge); dead links drop from view entirely and surface only as a
// health warning so a real file can be restored or the row repaired.
function renderIndexCatalog(entries: readonly IndexEntry[], deadPaths: ReadonlySet<string>): string {
  const active: string[] = [];
  const retired: string[] = [];
  for (const entry of entries) {
    if (deadPaths.has(entry.path)) continue;
    if (entry.status === "active") {
      active.push(`${entry.path} | ${entry.description}`);
    } else {
      retired.push(`[${entry.status.toUpperCase()}] ${entry.path} | ${entry.description}`);
    }
  }
  const parts: string[] = [];
  if (active.length > 0) parts.push(active.join("\n"));
  if (retired.length > 0) {
    parts.push(
      `retired (folded — superseded/archived/deprecated; consult only when a task explicitly needs the history, never as current knowledge):\n${retired.join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

function appendRootKnowledge(
  sections: string[],
  label: string,
  root: string,
  cache: Map<string, ScopeEntry>,
  includeBody: boolean,
): void {
  const entry = readScope(root, cache, root);
  if (!entry?.content) return;
  const { always, areas, rest } = extractRootSections(entry.content);
  if (always) sections.push(`${label}-rules:\n${always}`);
  if (areas) sections.push(`${label}-areas:\n${areas}`);
  if (includeBody && rest) sections.push(`${label}-knowledge:\n${rest}`);
}

/** Read each distinct project/workspace/global index exactly once, then append per-directory KNOWLEDGE.md scopes. */
export function buildKnowledgeSnapshot(activeScopes?: string[]): KnowledgeSnapshot {
  const sections: string[] = [];
  const issues: KnowledgeSnapshot["issues"] = [];
  const indexRoots: Array<{ root: string; scopes: KnowledgeScope[] }> = [];
  const projectRoot = getProjectRoot();
  const workspaceRoot = getWorkspaceRoot();
  const activeScopeSet = new Set((activeScopes ?? []).map(scope => resolve(scope)));
  const scopeCache = new Map<string, ScopeEntry>();
  const scopedRoots = (["project", "workspace", "global"] as const).map(scope => ({
    scope,
    root: getKnowledgeRoot(scope),
  }));
  const rootKnowledgeRoots: Array<{
    root: string;
    scopes: Array<"project" | "workspace">;
  }> = [];

  for (const { scope, root } of scopedRoots) {
    const existing = indexRoots.find(candidate => candidate.root === root);
    if (existing) existing.scopes.push(scope);
    else indexRoots.push({ root, scopes: [scope] });
  }
  for (const { scope, root } of [
    { scope: "project" as const, root: projectRoot },
    { scope: "workspace" as const, root: workspaceRoot },
  ]) {
    const existing = rootKnowledgeRoots.find(candidate => candidate.root === root);
    if (existing) existing.scopes.push(scope);
    else rootKnowledgeRoots.push({ root, scopes: [scope] });
  }
  const rootKnowledgeScopes = new Set(rootKnowledgeRoots.map(({ root }) => root));

  sections.push([
    "knowledge-catalog:",
    ...indexRoots.map(({ scopes, root }) => `${scopes.join("+")}-index: ${join(root, "index.md")}`),
    ...rootKnowledgeRoots.map(
      ({ scopes, root }) => `${scopes.join("+")}-areas: ${join(root, "KNOWLEDGE.md")}#Areas`,
    ),
  ].join("\n"));

  for (const { root, scopes } of indexRoots) {
    const scope = scopes[0];
    try {
      const scopeIssues = auditIndex(scope);
      for (const issue of scopeIssues) issues.push({ scope, issue });
      // Dead links (missing/invalid) are reported above but excluded from the
      // catalog: injecting a row whose file is gone is pure misdirection.
      const deadPaths = new Set(scopeIssues.map(issue => issue.path));
      const body = renderIndexCatalog(getIndex(scope), deadPaths);
      if (body) {
        sections.push(`knowledge(${scopes.join("+")}:${join(root, "index.md")}):\n${body}`);
      }
    } catch (error: any) {
      issues.push({
        scope,
        issue: { path: "index.md", reason: "invalid", detail: error?.message },
      });
    }
  }

  // Root Always/Areas are navigation; other root body becomes visible only after activation.
  for (const { root, scopes } of rootKnowledgeRoots) {
    appendRootKnowledge(
      sections,
      scopes.join("+"),
      root,
      scopeCache,
      activeScopeSet.has(root),
    );
  }

  // Per-directory KNOWLEDGE.md: active scopes from last turn's file access
  for (const normalizedScope of activeScopeSet) {
    if (rootKnowledgeScopes.has(normalizedScope)) continue;
    const entry = readScope(normalizedScope, scopeCache, projectRoot);
    if (!entry?.content) continue;
    const relative = normalizedScope.startsWith(workspaceRoot + "/")
      ? normalizedScope.slice(workspaceRoot.length + 1)
      : normalizedScope;
    sections.push(`scope(${relative}):\n${entry.content}`);
  }

  const content = sections.join("\n\n");
  return { content, bytes: Buffer.byteLength(content, "utf-8"), issues };
}

/** Build complete non-critical references and return critical notes separately. */
export function buildBoardSnapshot(participatingTopics: ReadonlySet<string>): BoardSnapshot {
  const capture = readParticipatingTopics(participatingTopics);
  return capture.topics === null
    ? emptyBoardSnapshot()
    : readBoardSnapshotFrom(capture.topics).snapshot;
}

function emptyBoardSnapshot(): BoardSnapshot {
  return {
    content: "",
    bytes: 0,
    topicSeqs: {},
    topicStates: {},
    topicIncarnations: {},
    criticalUpdates: [],
  };
}

function readParticipatingTopics(
  participatingTopics?: ReadonlySet<string>,
): { topics: Topic[] | null; warning?: string } {
  try {
    return {
      topics: listOpenTopics()
        .filter(topic => !participatingTopics || participatingTopics.has(topic.id))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  } catch (error: any) {
    // An incomplete listing cannot distinguish a closed topic from a read
    // failure. Defer this delivery instead of fabricating state transitions.
    return {
      topics: null,
      warning: `open-topic listing failed${error?.message ? `: ${error.message}` : ""}`,
    };
  }
}

function readBoardSnapshotFrom(
  openParticipating: readonly Topic[],
): { snapshot: BoardSnapshot; failedTopics: string[] } {
  const sections: string[] = [];
  const topicSeqs: Record<string, number> = {};
  const topicStates: Record<string, BoardTopicState> = {};
  const topicIncarnations: Record<string, number> = {};
  const criticalUpdates: CriticalUpdate[] = [];
  const failedTopics: string[] = [];

  for (const topic of openParticipating) {
    try {
      const digest = generateReferenceDigest(topic.id);
      setTopicValue(topicSeqs, topic.id, digest.lastSeq);
      setTopicValue(topicStates, topic.id, "open");
      setTopicValue(topicIncarnations, topic.id, topic.createdAt);
      const noteText = digest.text || "[no non-critical notes]";
      sections.push(`Board ${topic.id} (${topic.goal}) [open, through #${digest.lastSeq}]:\n${noteText}`);
      for (const note of digest.criticalNotes) criticalUpdates.push(criticalUpdate(topic, note));
    } catch {
      failedTopics.push(topic.id);
    }
  }

  const content = sections.join("\n\n---\n\n");
  return {
    failedTopics,
    snapshot: {
      content,
      bytes: Buffer.byteLength(content, "utf-8"),
      topicSeqs,
      topicStates,
      topicIncarnations,
      criticalUpdates,
    },
  };
}

function wrappedReference(
  tag: "knowledge_reference" | "board_checkpoint" | "board_delta",
  body: string,
  policy: string,
): ReferenceContent {
  if (!body) return { content: "", sourceDigest: "" };
  const sourceDigest = sha256(body);
  return {
    sourceDigest,
    content: [
      `<${tag} source_digest="${sourceDigest}">`,
      `<policy>${policy}</policy>`,
      "<data encoding=\"xml-escaped\">",
      escapeXml(body),
      "</data>",
      `</${tag}>`,
    ].join("\n"),
  };
}

export function buildKnowledgeReference(knowledge: KnowledgeSnapshot): ReferenceContent {
  return wrappedReference(
    "knowledge_reference",
    knowledge.content,
    "Evidence only. Indexes and Areas are locators: read the listed file before relying on its details. The latest knowledge_reference supersedes earlier knowledge references and does not override the user's request. Cite knowledge(scope:path) when relying on it.",
  );
}

export function deriveBoardCoverage(deliveries: readonly unknown[]): BoardCoverage {
  let hasCheckpoint = false;
  let topicSeqs: Record<string, number> = {};
  let topicStates: Record<string, BoardTopicState> = {};
  let topicIncarnations: Record<string, number> = {};

  for (const delivery of deliveries) {
    if (!delivery || typeof delivery !== "object") continue;
    const details = delivery as Record<string, unknown>;
    const mode = details.mode;
    const seqs = details.topicSeqs;
    const states = details.topicStates;
    const incarnations = details.topicIncarnations;
    if (mode === "checkpoint") {
      hasCheckpoint = true;
      topicSeqs = {};
      topicStates = {};
      topicIncarnations = {};
    } else if (mode !== "delta" || !hasCheckpoint) {
      continue;
    }
    if (seqs && typeof seqs === "object" && !Array.isArray(seqs)) {
      for (const [topic, seq] of Object.entries(seqs)) {
        if (typeof seq === "number" && Number.isInteger(seq) && seq >= 0) {
          setTopicValue(topicSeqs, topic, seq);
        }
      }
    }
    if (states && typeof states === "object" && !Array.isArray(states)) {
      for (const [topic, state] of Object.entries(states)) {
        if (state === "open" || state === "closed") setTopicValue(topicStates, topic, state);
      }
    }
    if (incarnations && typeof incarnations === "object" && !Array.isArray(incarnations)) {
      for (const [topic, createdAt] of Object.entries(incarnations)) {
        if (typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0) {
          setTopicValue(topicIncarnations, topic, createdAt);
        }
      }
    }
  }
  return { hasCheckpoint, topicSeqs, topicStates, topicIncarnations };
}

export function boardCriticalKey(topic: string, createdAt: number, seq: number): string {
  return `${encodeURIComponent(topic)}@${createdAt}#${seq}`;
}

function criticalUpdate(
  topic: { id: string; goal: string; createdAt: number },
  note: Note,
): CriticalUpdate {
  return {
    topic: topic.id,
    goal: topic.goal,
    note,
    key: boardCriticalKey(topic.id, topic.createdAt, note.seq),
  };
}

/** Plan either one complete active-context checkpoint or only the unseen seq deltas. */
export function buildBoardDelivery(
  participatingTopics: ReadonlySet<string>,
  coverage: BoardCoverage,
): BoardDelivery {
  return buildBoardDeliveryFromCapture(
    readParticipatingTopics(participatingTopics),
    coverage,
    participatingTopics,
  );
}

function buildBoardDeliveryFromCapture(
  capture: ReturnType<typeof readParticipatingTopics>,
  coverage: BoardCoverage,
  participatingTopics: ReadonlySet<string>,
): BoardDelivery {
  if (capture.topics === null) {
    return {
      ...emptyBoardSnapshot(),
      mode: "none",
      logicalBytes: 0,
      resetTopics: [],
      warnings: capture.warning ? [capture.warning] : undefined,
    };
  }
  const topics = capture.topics;

  if (!coverage.hasCheckpoint) {
    const { snapshot: logical, failedTopics } = readBoardSnapshotFrom(topics);
    if (failedTopics.length > 0) {
      return {
        ...emptyBoardSnapshot(),
        mode: "none",
        logicalBytes: 0,
        resetTopics: [],
        warnings: failedTopics.map(topic => `open topic ${topic} body read failed; checkpoint deferred`),
      };
    }
    const openIds = new Set(topics.map(topic => topic.id));
    const archiveFailures: string[] = [];
    // A full active-context reset removes both the earlier tombstone metadata
    // and independently visible CRITICAL messages. Rebuild closed participant
    // identities from their immutable archives so exact CRITICAL text remains
    // recoverable even though only open topic bodies belong in the checkpoint.
    for (const topic of participatingTopics) {
      if (openIds.has(topic)) continue;
      try {
        const archived = readArchivedTopic(topic);
        setTopicValue(logical.topicSeqs, topic, archived.notes.at(-1)?.seq ?? 0);
        setTopicValue(logical.topicStates, topic, "closed");
        setTopicValue(logical.topicIncarnations, topic, archived.topic.createdAt);
        for (const note of archived.notes) {
          if (note.priority === "critical") {
            logical.criticalUpdates.push(criticalUpdate(archived.topic, note));
          }
        }
      } catch (error: any) {
        archiveFailures.push(
          `participating topic ${topic} is absent from the open listing and its archive is unavailable or invalid${error?.message ? `: ${error.message}` : ""}; checkpoint deferred`,
        );
      }
    }
    if (archiveFailures.length > 0) {
      return {
        ...emptyBoardSnapshot(),
        mode: "none",
        logicalBytes: 0,
        resetTopics: [],
        warnings: archiveFailures,
      };
    }
    const checkpointBody = logical.content || "[no participating open Board topics]";
    const reference = wrappedReference(
      "board_checkpoint",
      checkpointBody,
      "Complete non-critical state of every participating open Board topic at this checkpoint. Later board_delta messages apply in topic seq order; CRITICAL notes arrive as separate visible messages. Cite Board topic#seq when relying on a note.",
    );
    return {
      ...logical,
      mode: "checkpoint",
      content: reference.content,
      bytes: Buffer.byteLength(reference.content, "utf-8"),
      logicalBytes: logical.bytes,
      resetTopics: topics.filter(topic => hasArchivedTopic(topic.id)).map(topic => topic.id),
      warnings: topics.some(topic => hasArchivedTopic(topic.id))
        ? ["legacy reused topic identity detected; full checkpoint refreshed active incarnations"]
        : undefined,
    };
  }

  const sections: string[] = [];
  const topicSeqs: Record<string, number> = {};
  const topicStates: Record<string, BoardTopicState> = {};
  const topicIncarnations: Record<string, number> = {};
  const criticalUpdates: CriticalUpdate[] = [];
  const warnings: string[] = [];
  const resetTopics = new Set<string>();
  // Capture membership before reading any topic body. A single concurrent
  // topic read must never make later still-open topics look closed.
  const currentOpen = new Set(topics.map(topic => topic.id));
  for (const topic of topics) {
    try {
      const coveredIncarnation = getTopicValue(coverage.topicIncarnations, topic.id);
      const coveredState = getTopicValue(coverage.topicStates, topic.id);
      const legacyReuse = coveredState === "open"
        && coveredIncarnation === undefined
        && hasArchivedTopic(topic.id);
      const incarnationChanged = coveredIncarnation !== undefined
        && coveredIncarnation !== topic.createdAt;
      let wasOpen = coveredState === "open"
        && !legacyReuse
        && !incarnationChanged;
      const since = wasOpen ? getTopicValue(coverage.topicSeqs, topic.id) ?? 0 : 0;
      const digest = generateReferenceDigest(topic.id, {
        lastSeq: since,
        includeAllCritical: true,
      });
      if (digest.cursorReset) wasOpen = false;
      if (legacyReuse || incarnationChanged || digest.cursorReset) resetTopics.add(topic.id);
      setTopicValue(topicSeqs, topic.id, digest.lastSeq);
      setTopicValue(topicStates, topic.id, "open");
      setTopicValue(topicIncarnations, topic.id, topic.createdAt);
      for (const note of digest.criticalNotes) criticalUpdates.push(criticalUpdate(topic, note));

      if (!wasOpen) {
        if (legacyReuse) {
          warnings.push(`legacy reused topic ${topic.id} detected; full active incarnation resent`);
        } else if (incarnationChanged) {
          warnings.push(`topic ${topic.id} incarnation changed; full active incarnation resent`);
        } else if (digest.cursorReset) {
          warnings.push(`topic ${topic.id} seq cursor regressed; full active incarnation resent`);
        }
        sections.push([
          `Board ${topic.id} (${topic.goal}) [topic_opened, through #${digest.lastSeq}]:`,
          digest.text || "[no non-critical notes]",
        ].join("\n"));
      } else if (digest.text) {
        sections.push([
          `Board ${topic.id} (${topic.goal}) [delta after #${since}, through #${digest.lastSeq}]:`,
          digest.text,
        ].join("\n"));
      }
    } catch {
      // Keep the topic in currentOpen and retain its prior cursor. A later turn
      // will retry the body after a concurrent rename/write has settled.
      warnings.push(`open topic ${topic.id} body read failed; prior cursor retained`);
    }
  }

  for (const [topic, state] of Object.entries(coverage.topicStates)) {
    if (state !== "open" || currentOpen.has(topic)) continue;
    try {
      // A close may land between open-topic listing and this loop. Publish the
      // tombstone only after the archive is readable and every note beyond the
      // active cursor has been delivered; otherwise retry next turn.
      const archived = readArchivedTopic(topic);
      const coveredIncarnation = getTopicValue(coverage.topicIncarnations, topic);
      if (coveredIncarnation !== undefined && coveredIncarnation !== archived.topic.createdAt) {
        warnings.push(`closed topic ${topic} archive incarnation mismatch; prior open cursor retained`);
        continue;
      }
      const since = getTopicValue(coverage.topicSeqs, topic) ?? 0;
      const digest = generateReferenceDigestFromNotes(archived.notes, {
        lastSeq: since,
        includeAllCritical: true,
      });
      setTopicValue(topicSeqs, topic, digest.lastSeq);
      setTopicValue(topicStates, topic, "closed");
      setTopicValue(topicIncarnations, topic, archived.topic.createdAt);
      for (const note of digest.criticalNotes) {
        criticalUpdates.push(criticalUpdate(archived.topic, note));
      }
      if (digest.cursorReset) {
        resetTopics.add(topic);
        warnings.push(`closed topic ${topic} seq cursor regressed; full archive incarnation resent`);
      }
      if (digest.text) {
        sections.push([
          `Board ${topic} (${archived.topic.goal}) [${digest.cursorReset ? "final incarnation replay" : `final delta after #${since}`}, through #${digest.lastSeq}]:`,
          digest.text,
        ].join("\n"));
      }
      sections.push(`<topic_closed id="${topic}" archive=".pi-board/topics/archive/${topic}.summary.md" />`);
    } catch (error: any) {
      warnings.push(
        `closed candidate ${topic} archive unavailable or invalid${error?.message ? `: ${error.message}` : ""}; prior open cursor retained`,
      );
    }
  }

  // A visible CRITICAL message may be compacted away independently from the
  // passive closing delta. Rebuild candidates for already-closed topics from
  // their immutable archive; activeCriticalKeys performs incarnation-aware
  // deduplication before anything is shown again.
  for (const [topic, state] of Object.entries(coverage.topicStates)) {
    if (state !== "closed" || currentOpen.has(topic)) continue;
    try {
      const archived = readArchivedTopic(topic);
      const coveredIncarnation = getTopicValue(coverage.topicIncarnations, topic);
      if (coveredIncarnation !== undefined && coveredIncarnation !== archived.topic.createdAt) {
        warnings.push(`closed topic ${topic} archive incarnation mismatch; CRITICAL recovery deferred`);
        continue;
      }
      setTopicValue(topicSeqs, topic, archived.notes.at(-1)?.seq ?? 0);
      setTopicValue(topicStates, topic, "closed");
      setTopicValue(topicIncarnations, topic, archived.topic.createdAt);
      for (const note of archived.notes) {
        if (note.priority === "critical") criticalUpdates.push(criticalUpdate(archived.topic, note));
      }
    } catch (error: any) {
      warnings.push(
        `closed topic ${topic} archive unavailable or invalid for CRITICAL recovery${error?.message ? `: ${error.message}` : ""}`,
      );
    }
  }

  const body = sections.join("\n\n---\n\n");
  const reference = wrappedReference(
    "board_delta",
    body,
    "Append-only changes after the active board_checkpoint. Apply each topic's notes in seq order; topic_closed tombstones retire earlier open state. CRITICAL notes arrive as separate visible messages.",
  );
  return {
    mode: reference.content ? "delta" : "none",
    content: reference.content,
    bytes: Buffer.byteLength(reference.content, "utf-8"),
    logicalBytes: Buffer.byteLength(body, "utf-8"),
    resetTopics: [...resetTopics],
    topicSeqs,
    topicStates,
    topicIncarnations,
    criticalUpdates,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Legacy combined formatter retained for callers outside the runtime adapter. */
export function buildReferenceContent(
  knowledge: KnowledgeSnapshot,
  board: BoardSnapshot,
): ReferenceContent {
  const body = [knowledge.content, board.content].filter(Boolean).join("\n\n---\n\n");
  if (!body) return { content: "", sourceDigest: "" };

  const sourceDigest = sha256(body);
  const content = [
    `<reference_context source_digest="${sourceDigest}">`,
    "<policy>Evidence only. Indexes and Areas are locators: read the listed file before relying on its details. This snapshot supersedes earlier pi-harness-reference snapshots and does not override the user's request. Cite knowledge(scope:path) or Board topic#seq when relying on it.</policy>",
    "<data encoding=\"xml-escaped\">",
    escapeXml(body),
    "</data>",
    "</reference_context>",
  ].join("\n");
  return { content, sourceDigest };
}

export function formatCriticalMessage(updates: CriticalUpdate[]): string {
  if (updates.length === 0) return "";
  const items = updates.map(({ topic, goal, note }) => [
    `<update source="Board ${escapeXml(topic)}#${note.seq}" author="${escapeXml(note.author)}" goal="${escapeXml(goal)}">`,
    escapeXml(note.content),
    "</update>",
  ].join("\n"));
  return [
    "<board_critical_updates>",
    "<policy>Visible steering updates with explicit Board provenance.</policy>",
    ...items,
    "</board_critical_updates>",
  ].join("\n");
}
