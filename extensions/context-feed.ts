import { createHash } from "node:crypto";
import { listOpenTopicCatalog } from "../core/board/index.ts";
import { boundedExcerpt, boundedIntEnv } from "../core/text-budget/index.ts";
import {
  buildBoardDelivery,
  boardCriticalKey,
  buildKnowledgeReference,
  buildKnowledgeSnapshot,
  deriveBoardCoverage,
  formatCriticalMessage,
  type BoardDelivery,
  type CriticalUpdate,
  type KnowledgeSnapshot,
} from "../core/context-reference/index.ts";
import { assessContextSize } from "../core/context-size/index.ts";
import { writeContextSnapshot } from "../core/context-snapshot/index.ts";
import { appendEvent } from "../core/events/index.ts";
import { findKnowledgeScope } from "../core/knowledge/scope.ts";

const LEGACY_REFERENCE_MESSAGE_TYPE = "pi-harness-reference";
const KNOWLEDGE_MESSAGE_TYPE = "pi-harness-knowledge-reference";
const BOARD_CHECKPOINT_MESSAGE_TYPE = "pi-harness-board-checkpoint";
const BOARD_DELTA_MESSAGE_TYPE = "pi-harness-board-delta";
const BOARD_CATALOG_MESSAGE_TYPE = "pi-harness-board-catalog";
const BOARD_CATALOG_DELTA_MESSAGE_TYPE = "pi-harness-board-catalog-delta";
const CRITICAL_MESSAGE_TYPE = "pi-harness-board-critical";
const CONTEXT_SNAPSHOT_ENTRY_TYPE = "pi-harness-context-snapshot";
const BOARD_PARTICIPATION_ENTRY_TYPE = "pi-harness-board-participation";
const RUNTIME_REFERENCE_TYPES = new Set([
  LEGACY_REFERENCE_MESSAGE_TYPE,
  KNOWLEDGE_MESSAGE_TYPE,
  BOARD_CHECKPOINT_MESSAGE_TYPE,
  BOARD_DELTA_MESSAGE_TYPE,
  BOARD_CATALOG_MESSAGE_TYPE,
  BOARD_CATALOG_DELTA_MESSAGE_TYPE,
  CRITICAL_MESSAGE_TYPE,
]);

interface SessionFeedState {
  activeKnowledgeScopes: Set<string>;
  /** Only joined topics may contribute note bodies or CRITICAL messages. */
  participatingTopics: Set<string>;
  /** Explicit metadata-only relationship, persisted for audit and resume. */
  participationModes: Map<string, "join" | "watch" | "defer">;
  participationReady: boolean;
  lastSizeWarningKey: string | null;
  lastHealthWarningKey: string | null;
  lastBoardWarningKey: string | null;
}

const sessionStates = new Map<string, SessionFeedState>();
const pendingDeliveryByTurn = new WeakMap<object, { catalog?: any; board?: any; critical?: any }>();

interface CatalogSnapshot {
  id: string;
  rowDigestByTopic: Record<string, string>;
}

interface CatalogReference {
  content: string;
  sourceDigest: string;
  rowDigestByTopic: Record<string, string>;
  mode: "checkpoint" | "delta";
  changed: boolean;
}

function sessionId(ctx: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // Fall through to the stable legacy bucket for runtimes without a manager.
  }
  return "unknown-session";
}

function emptySessionState(): SessionFeedState {
  return {
    activeKnowledgeScopes: new Set(),
    participatingTopics: new Set(),
    participationModes: new Map(),
    participationReady: false,
    lastSizeWarningKey: null,
    lastHealthWarningKey: null,
    lastBoardWarningKey: null,
  };
}

function stateFor(ctx: any): SessionFeedState {
  const id = sessionId(ctx);
  let state = sessionStates.get(id);
  if (!state) {
    state = emptySessionState();
    sessionStates.set(id, state);
  }
  return state;
}

const SCOPE_ACTIVATING_TOOLS = new Set(["read", "read_file", "edit", "write", "edit_file", "write_file"]);
const SCOPE_IGNORE_BASENAMES = new Set(["package.json", "package-lock.json", "tsconfig.json", ".gitignore", "README.md", "KNOWLEDGE.md", "LICENSE"]);

interface FrozenReference {
  id: string;
  path: string;
  content: string;
  bytes: number;
  frozenAt: number;
  kind: "knowledge" | "board-catalog" | "board-catalog-delta" | "board-checkpoint" | "board-delta" | "board-critical";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function contextWindowFrom(ctx: any): number | null {
  const value = ctx?.model?.contextWindow ?? ctx?.getContextUsage?.()?.contextWindow;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function emitHealthWarning(state: SessionFeedState, issues: KnowledgeSnapshot["issues"]): void {
  if (issues.length === 0) {
    state.lastHealthWarningKey = null;
    return;
  }
  const details = issues
    .map(({ scope, issue }) => `${scope}:${issue.path} (${issue.reason}${issue.detail ? `: ${issue.detail}` : ""})`)
    .join("; ");
  const key = sha256(details);
  if (key === state.lastHealthWarningKey) return;
  state.lastHealthWarningKey = key;

  const message = `Knowledge index health check found stale/invalid rows: ${details}. Review the selected index and remove or repair only confirmed obsolete entries; no automatic cleanup was performed.`;
  console.error(`[context-feed] WARN: ${message}`);
  try {
    appendEvent("hook_warn", { rule: "knowledge-index-health", issues, message });
  } catch {
    // Warning persistence is best-effort; reference delivery remains intact.
  }
}

function emitBoardWarning(state: SessionFeedState, warnings: readonly string[]): void {
  if (warnings.length === 0) {
    state.lastBoardWarningKey = null;
    return;
  }
  const details = warnings.join("; ");
  const key = sha256(details);
  if (key === state.lastBoardWarningKey) return;
  state.lastBoardWarningKey = key;
  const message = `Board delivery notice: ${details}. Source files were preserved; any deferred read will retry on the next turn.`;
  console.error(`[context-feed] WARN: ${message}`);
  try {
    appendEvent("hook_warn", { rule: "board-delivery-read-failed", warnings, message });
  } catch {
    // The append-only Board files remain the source of truth.
  }
}

function emitSizeWarning(
  state: SessionFeedState,
  injectedContent: string,
  knowledgeBytes: number,
  boardBytes: number,
  retainedBytes: number,
  ctx: any,
): void {
  const contextWindow = contextWindowFrom(ctx);
  if (!contextWindow) return;
  const assessment = assessContextSize(injectedContent, contextWindow);
  if (!assessment.shouldWarn) {
    state.lastSizeWarningKey = null;
    return;
  }
  const key = String(contextWindow);
  if (key === state.lastSizeWarningKey) return;
  state.lastSizeWarningKey = key;

  const percent = (assessment.ratio * 100).toFixed(1);
  const knowledgeTokens = Math.ceil(knowledgeBytes / 3);
  const boardTokens = Math.ceil(boardBytes / 3);
  const retainedTokens = Math.ceil(retainedBytes / 3);
  const message = `Full context preserved: ~${assessment.estimatedTokens} tokens (${percent}% of ${contextWindow}); current knowledge ~${knowledgeTokens}, active Board references ~${boardTokens}, retained runtime references ~${retainedTokens}. Review active project/workspace/global knowledge indexes and participating open Board topics for stale, incorrect, duplicate, or overly verbose content.`;
  console.error(`[context-feed] WARN: ${message}`);
  try {
    appendEvent("hook_warn", {
      rule: "context-injection-size",
      ...assessment,
      knowledgeBytes,
      boardBytes,
      retainedBytes,
      message,
    });
  } catch {
    // Warning persistence is best-effort; reference delivery remains intact.
  }
}

function freezeReference(
  pi: any,
  event: any,
  content: string,
  kind: FrozenReference["kind"],
  sourceDigest: string,
  extra: Record<string, unknown> = {},
): FrozenReference {
  const file = writeContextSnapshot(content);
  const snapshot: FrozenReference = {
    ...file,
    content,
    kind,
    frozenAt: Date.now(),
  };
  const metadata = {
    kind,
    snapshotId: snapshot.id,
    sourceDigest,
    path: snapshot.path,
    bytes: snapshot.bytes,
    promptDigest: sha256(String(event?.prompt ?? "")),
    frozenAt: snapshot.frozenAt,
    ...extra,
  };
  pi.appendEntry?.("pi-harness-context-snapshot", metadata);
  try {
    appendEvent("context_snapshot", metadata);
  } catch {
    // The content-addressed snapshot file remains the source of truth.
  }
  return snapshot;
}

function hiddenMessage(
  customType: string,
  snapshot: FrozenReference,
  details: Record<string, unknown>,
): any {
  return {
    customType,
    content: snapshot.content,
    display: false,
    details: {
      snapshotId: snapshot.id,
      path: snapshot.path,
      bytes: snapshot.bytes,
      frozenAt: snapshot.frozenAt,
      state: "active",
      ...details,
    },
  };
}

function activeEntries(ctx: any): any[] {
  const entries = ctx?.sessionManager?.buildContextEntries?.();
  return Array.isArray(entries) ? entries : [];
}

function latestActiveSnapshotId(entries: any[], customType: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom_message" || entry.customType !== customType) continue;
    return typeof entry.details?.snapshotId === "string" ? entry.details.snapshotId : undefined;
  }
  return undefined;
}

/**
 * New catalog messages persist the complete row-digest state in metadata, so
 * one retained delta remains sufficient after compaction. Legacy catalog
 * messages lack that state and intentionally trigger one fresh checkpoint.
 */
function latestCatalogSnapshot(entries: any[]): CatalogSnapshot | undefined {
  // A delta has meaning only alongside a retained checkpoint. If compaction
  // removed that base, emit a new complete catalog rather than making rows
  // invisible or assuming model memory survived.
  if (!entries.some(entry => entry?.type === "custom_message"
    && entry.customType === BOARD_CATALOG_MESSAGE_TYPE
    // Old full catalogs had no mode; new deltas explicitly say delta.
    && (entry.details?.mode === undefined || entry.details?.mode === "checkpoint"))) {
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom_message") continue;
    if (entry.customType !== BOARD_CATALOG_MESSAGE_TYPE
      && entry.customType !== BOARD_CATALOG_DELTA_MESSAGE_TYPE) continue;
    const id = entry.details?.snapshotId;
    const rows = entry.details?.catalogRowDigests;
    if (typeof id !== "string" || !rows || typeof rows !== "object" || Array.isArray(rows)) continue;
    const rowDigestByTopic: Record<string, string> = {};
    for (const [topic, digest] of Object.entries(rows)) {
      if (typeof digest === "string") rowDigestByTopic[topic] = digest;
    }
    return { id, rowDigestByTopic };
  }
  return undefined;
}

function contextSnapshotMetadata(entries: any[]): Map<string, Record<string, any>> {
  const bySnapshotId = new Map<string, Record<string, any>>();
  for (const entry of entries) {
    if (entry?.type !== "custom" || entry.customType !== CONTEXT_SNAPSHOT_ENTRY_TYPE) continue;
    const data = entry.data;
    if (data && typeof data === "object" && typeof data.snapshotId === "string") {
      bySnapshotId.set(data.snapshotId, data);
    }
  }
  return bySnapshotId;
}

function activeBoardDeliveryDetails(entries: any[], metadataEntries: any[]): unknown[] {
  const metadata = contextSnapshotMetadata(metadataEntries);
  return entries
    .filter(entry => entry?.type === "custom_message"
      && (entry.customType === LEGACY_REFERENCE_MESSAGE_TYPE
        || entry.customType === BOARD_CHECKPOINT_MESSAGE_TYPE
        || entry.customType === BOARD_DELTA_MESSAGE_TYPE
        || entry.customType === CRITICAL_MESSAGE_TYPE))
    .map(entry => {
      if (entry.customType !== LEGACY_REFERENCE_MESSAGE_TYPE) return entry.details;
      // A pre-ADR-0018 combined reference already contains a complete Board
      // snapshot. Treat it as the initial checkpoint so an in-place upgrade
      // appends deltas instead of duplicating the whole Board near the window
      // boundary. A legacy cleared marker represents an empty checkpoint.
      const snapshot = metadata.get(entry.details?.snapshotId);
      const rawSeqs = entry.details?.state === "cleared" ? {} : snapshot?.topicSeqs;
      const topicSeqs = rawSeqs && typeof rawSeqs === "object" && !Array.isArray(rawSeqs)
        ? rawSeqs
        : {};
      return {
        mode: "checkpoint",
        topicSeqs,
        topicStates: Object.fromEntries(Object.keys(topicSeqs).map(topic => [topic, "open"])),
      };
    });
}

function setParticipation(
  pi: any,
  state: SessionFeedState,
  topic: string,
  mode: "join" | "watch" | "defer",
  reason?: string,
  legacy = false,
): void {
  state.participationModes.set(topic, mode);
  if (mode === "join") state.participatingTopics.add(topic);
  else state.participatingTopics.delete(topic);
  pi.appendEntry?.(BOARD_PARTICIPATION_ENTRY_TYPE, {
    action: "set",
    topic,
    mode,
    ...(reason && { reason }),
    ...(legacy && { legacy }),
    changedAt: Date.now(),
  });
}

function restoreParticipatingTopics(pi: any, ctx: any, state: SessionFeedState): boolean {
  state.participatingTopics.clear();
  state.participationModes.clear();
  const entries = activeEntries(ctx);
  const branch = ctx?.sessionManager?.getBranch?.();
  const history = Array.isArray(branch) ? branch : entries;
  let hasPersistedInitialization = false;

  for (const entry of history) {
    if (entry?.type !== "custom" || entry.customType !== BOARD_PARTICIPATION_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!data || typeof data !== "object") continue;
    if (data.action === "set" && typeof data.topic === "string"
      && ["join", "watch", "defer"].includes(data.mode)) {
      state.participationModes.set(data.topic, data.mode);
      if (data.mode === "join") state.participatingTopics.add(data.topic);
      else state.participatingTopics.delete(data.topic);
      hasPersistedInitialization = true;
    } else if (data.action === "initialize-catalog-only") {
      hasPersistedInitialization = true;
    } else if (data.action === "initialize" && Array.isArray(data.topics)) {
      // Pre-ADR-0029 initialization meant full participation; retain it so a
      // resumed legacy session never silently loses previously injected work.
      hasPersistedInitialization = true;
      for (const topic of data.topics) {
        if (typeof topic === "string" && topic.length > 0) {
          state.participationModes.set(topic, "join");
          state.participatingTopics.add(topic);
        }
      }
    } else if (data.action === "join" && typeof data.topic === "string" && data.topic.length > 0) {
      state.participationModes.set(data.topic, "join");
      state.participatingTopics.add(data.topic);
      hasPersistedInitialization = true;
    }
  }

  // ADR-0018 messages predate the explicit participation entry. Their cursor
  // metadata is enough to rebuild the same visibility set on resume.
  const historicalCoverage = deriveBoardCoverage(activeBoardDeliveryDetails(history, history));
  if (historicalCoverage.hasCheckpoint) {
    hasPersistedInitialization = true;
    for (const topic of Object.keys(historicalCoverage.topicStates)) {
      // Pre-ADR-0029 references already exposed the full body. Preserve their
      // membership on resume; do not retroactively claim catalog-only.
      state.participationModes.set(topic, "join");
      state.participatingTopics.add(topic);
    }
  }
  if (hasPersistedInitialization) return true;

  // Fresh sessions are catalog-only by default. Discovery and full evidence
  // participation are deliberately separate (ADR-0029).
  try { listOpenTopicCatalog(); } catch { return false; }
  pi.appendEntry?.(BOARD_PARTICIPATION_ENTRY_TYPE, {
    action: "initialize-catalog-only",
    topics: [],
    joinedAt: Date.now(),
  });
  return true;
}

/**
 * Return metadata for every open/closed Board topic without granting note-body
 * visibility. This is the shared-directory discovery channel; it intentionally
 * never mutates participation state.
 */
function boundedCatalogList(values: readonly string[], cap: number, label: string): string {
  if (values.length === 0) return "";
  const itemCap = boundedIntEnv("PI_BOARD_CATALOG_ITEM_EXCERPT_BYTES", 240);
  const shown = values.slice(0, cap).map(value => boundedExcerpt(value, itemCap)).join(",");
  const overflow = values.length > cap ? ` ${label}_total=${values.length}` : "";
  return ` ${label}=${shown}${overflow}`;
}

function catalogTimestamp(value: number): string {
  // Topic schema already requires a valid Date, but preserve fail-loud catalog
  // discovery if a manually edited legacy file violates that invariant.
  const rendered = new Date(value).toISOString();
  return rendered;
}

function catalogRow(topic: ReturnType<typeof listOpenTopicCatalog>[number], state: SessionFeedState): string {
  const goalCap = boundedIntEnv("PI_BOARD_GOAL_EXCERPT_BYTES", 240);
  const listCap = boundedIntEnv("PI_BOARD_CATALOG_MAX_LIST", 16);
  const itemCap = boundedIntEnv("PI_BOARD_CATALOG_ITEM_EXCERPT_BYTES", 240);
  const mode = state.participationModes.get(topic.id) ?? "catalog";
  const creator = topic.createdBy?.id
    ? boundedExcerpt(topic.createdBy.id, itemCap)
    : "unknown";
  const critical = topic.criticalCount > 0
    ? ` critical=${topic.criticalCount}${topic.lastCriticalSeq ? ` lastCritical=#${topic.lastCriticalSeq}` : ""}`
    : "";
  const participants = boundedCatalogList(topic.participants, listCap, "participants");
  const relations = boundedCatalogList(topic.relations.map(r => `${r.type}:${r.topic}`), listCap, "relations");
  // These volatile fields are intentional: the row-delta protocol emits only
  // this changed card, so peers can audit who created it and when it changed
  // without re-injecting the entire catalog.
  return `- ${boundedExcerpt(topic.id, boundedIntEnv("PI_BOARD_TOPIC_EXCERPT_BYTES", 240))} [${mode}; open; createdBy=${creator}; createdAt=${catalogTimestamp(topic.createdAt)}; activity=${catalogTimestamp(topic.lastActivityAt)}; notes=${topic.noteCount}; through=#${topic.lastSeq}${critical}${participants}${relations}] — ${boundedExcerpt(topic.goal, goalCap)}`;
}

function catalogEnvelope(
  tag: "board_catalog" | "board_catalog_delta",
  sourceDigest: string,
  body: string,
): string {
  return [
    `<${tag} source_digest="${sourceDigest}">`,
    "<policy>Metadata-only discovery for every open project Board topic. Join a topic before receiving its automatic note-body feed; an explicit Board read is a one-shot inspection. Watch/defer are not participation. Agent-authored CRITICAL text remains inside joined topics.</policy>",
    "<data encoding=\"xml-escaped\">",
    body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    "</data>",
    `</${tag}>`,
  ].join("\n");
}

function catalogReferenceFromRows(
  rows: ReturnType<typeof listOpenTopicCatalog>,
  state: SessionFeedState,
  previous?: CatalogSnapshot,
): CatalogReference {
  const catalogLimit = boundedIntEnv("PI_BOARD_CATALOG_MAX_TOPICS", 1000);
  if (rows.length > catalogLimit) {
    throw new Error(`open topic catalog has ${rows.length} rows, above explicit PI_BOARD_CATALOG_MAX_TOPICS=${catalogLimit}`);
  }
  const rowsByTopic = Object.fromEntries(rows.map(topic => [topic.id, catalogRow(topic, state)]));
  const rowDigestByTopic = Object.fromEntries(Object.entries(rowsByTopic).map(([topic, row]) => [topic, sha256(row)]));
  const isCheckpoint = !previous;
  const changed = Object.entries(rowsByTopic)
    .filter(([topic, row]) => isCheckpoint || previous.rowDigestByTopic[topic] !== sha256(row))
    .map(([, row]) => row);
  const closed = previous
    ? Object.keys(previous.rowDigestByTopic).filter(topic => !Object.hasOwn(rowsByTopic, topic))
      .map(topic => `<topic_closed id="${boundedExcerpt(topic, boundedIntEnv("PI_BOARD_TOPIC_EXCERPT_BYTES", 240))}" />`)
    : [];
  const changedAny = isCheckpoint || changed.length > 0 || closed.length > 0;
  const body = [...changed, ...closed].join("\n");
  const sourceDigest = sha256(body);
  if (!changedAny) return { sourceDigest, content: "", rowDigestByTopic, mode: "delta", changed: false };
  const content = catalogEnvelope(isCheckpoint ? "board_catalog" : "board_catalog_delta", sourceDigest, body || "[no open Board topics]");
  const contentCap = boundedIntEnv("PI_BOARD_CATALOG_MAX_BYTES", 64000);
  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (contentBytes > contentCap) {
    throw new Error(`Board catalog ${isCheckpoint ? "checkpoint" : "delta"} is ${contentBytes} escaped bytes, above explicit PI_BOARD_CATALOG_MAX_BYTES=${contentCap}`);
  }
  return { sourceDigest, content, rowDigestByTopic, mode: isCheckpoint ? "checkpoint" : "delta", changed: true };
}

function buildCatalogReference(state: SessionFeedState, previous?: CatalogSnapshot): CatalogReference {
  return catalogReferenceFromRows(listOpenTopicCatalog(), state, previous);
}

function unavailableBoardDelivery(warning: string): BoardDelivery {
  return {
    mode: "none",
    content: "",
    bytes: 0,
    logicalBytes: 0,
    resetTopics: [],
    topicSeqs: {},
    topicStates: {},
    topicIncarnations: {},
    criticalUpdates: [],
    warnings: [warning],
  };
}

function persistedRuntimeReferenceContent(entries: any[]): string {
  return entries
    .filter(entry => entry?.type === "custom_message" && RUNTIME_REFERENCE_TYPES.has(entry.customType))
    .map(entry => typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content ?? []))
    .join("\n\n");
}

function activeBoardReferenceBytes(entries: any[], metadataEntries: any[]): number {
  const metadata = contextSnapshotMetadata(metadataEntries);
  let bytes = 0;
  for (const entry of entries) {
    if (entry?.type !== "custom_message") continue;
    if (entry.customType === LEGACY_REFERENCE_MESSAGE_TYPE) {
      const boardBytes = metadata.get(entry.details?.snapshotId)?.boardBytes;
      if (entry.details?.state !== "cleared" && Number.isFinite(boardBytes)) {
        bytes += Math.max(0, Number(boardBytes));
      }
      continue;
    }
    if (entry.customType !== BOARD_CHECKPOINT_MESSAGE_TYPE
      && entry.customType !== BOARD_DELTA_MESSAGE_TYPE
      && entry.customType !== BOARD_CATALOG_MESSAGE_TYPE
      && entry.customType !== BOARD_CATALOG_DELTA_MESSAGE_TYPE
      && entry.customType !== CRITICAL_MESSAGE_TYPE) continue;
    const content = typeof entry.content === "string"
      ? entry.content
      : JSON.stringify(entry.content ?? []);
    bytes += Buffer.byteLength(content, "utf-8");
  }
  return bytes;
}

function activeCriticalKeys(entries: any[], delivery: BoardDelivery): Set<string> {
  const keys = new Set<string>();
  const resetTopics = new Set(delivery.resetTopics);
  for (const entry of entries) {
    if (entry?.type !== "custom_message" || entry.customType !== CRITICAL_MESSAGE_TYPE) continue;
    const persistedKeys = entry.details?.criticalKeys;
    if (Array.isArray(persistedKeys)) {
      for (const key of persistedKeys) {
        if (typeof key === "string") keys.add(key);
      }
      continue;
    }
    // Pre-incarnation messages only persisted human-readable Board topic#seq
    // sources. Map those to the current incarnation only when Board delivery
    // found no evidence of legacy ID reuse or cursor reset this turn.
    const sources = entry.details?.sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (typeof source !== "string" || !source.startsWith("Board ")) continue;
      const identity = source.slice("Board ".length);
      const separator = identity.lastIndexOf("#");
      if (separator <= 0) continue;
      const topic = identity.slice(0, separator);
      const seq = Number(identity.slice(separator + 1));
      const createdAt = Object.hasOwn(delivery.topicIncarnations, topic)
        ? delivery.topicIncarnations[topic]
        : undefined;
      if (!Number.isInteger(seq) || seq < 0 || !createdAt || resetTopics.has(topic)) continue;
      keys.add(boardCriticalKey(topic, createdAt, seq));
    }
  }
  return keys;
}

function criticalMessage(
  updates: CriticalUpdate[],
  delivery: BoardDelivery,
  snapshot: FrozenReference,
): any {
  return {
    customType: CRITICAL_MESSAGE_TYPE,
    content: snapshot.content,
    display: true,
    details: {
      kind: "board-critical",
      mode: "critical",
      snapshotId: snapshot.id,
      path: snapshot.path,
      bytes: snapshot.bytes,
      frozenAt: snapshot.frozenAt,
      state: "active",
      topicSeqs: delivery.topicSeqs,
      topicStates: delivery.topicStates,
      topicIncarnations: delivery.topicIncarnations,
      criticalKeys: updates.map(update => update.key),
      sources: updates.map(update => `Board ${update.topic}#${update.note.seq}`),
    },
  };
}

export default async function (pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const state = emptySessionState();
    sessionStates.set(sessionId(ctx), state);
    state.participationReady = restoreParticipatingTopics(pi, ctx, state);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    sessionStates.delete(sessionId(ctx));
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName !== "board" || event.isError === true) return;
    const input = event.input || event.args || {};
    const state = stateFor(ctx);
    if (typeof input.topic !== "string" || input.topic.length === 0) return;
    if (input.action === "participate") {
      if (["join", "watch", "defer"].includes(input.mode)) {
        setParticipation(pi, state, input.topic, input.mode, input.reason);
      }
      return;
    }
    // Mutating a topic is an explicit act of participation, unlike merely
    // discovering a peer topic in the shared catalog.
    if ((input.action === "open" || input.action === "post") && !state.participatingTopics.has(input.topic)) {
      setParticipation(pi, state, input.topic, "join", "local-board-mutation");
    }
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = (event.tool || event.toolName || "").toLowerCase();
    if (!SCOPE_ACTIVATING_TOOLS.has(toolName)) return;
    const input = event.input || event.args || {};
    const filePath: string | undefined = input.file_path || input.path;
    if (!filePath) return;
    const basename = filePath.split("/").pop() || "";
    if (SCOPE_IGNORE_BASENAMES.has(basename)) return;
    if (filePath.includes("node_modules/") || filePath.includes(".git/")) return;
    const scopeDir = findKnowledgeScope(filePath, process.cwd());
    if (scopeDir) stateFor(ctx).activeKnowledgeScopes.add(scopeDir);
  });

  // First handler plans one user-turn delivery and emits the independent
  // knowledge message. Later handlers persist Board delta and CRITICAL updates.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const pending: { catalog?: any; board?: any; critical?: any } = {};
    pendingDeliveryByTurn.set(ctx, pending);
    const entries = activeEntries(ctx);
    const branch = ctx?.sessionManager?.getBranch?.();
    const metadataEntries = Array.isArray(branch) ? branch : entries;
    const state = stateFor(ctx);
    const knowledge = buildKnowledgeSnapshot([...state.activeKnowledgeScopes]);
    const knowledgeReference = buildKnowledgeReference(knowledge);
    const coverage = deriveBoardCoverage(activeBoardDeliveryDetails(entries, metadataEntries));
    if (!state.participationReady && state.participationModes.size === 0) {
      state.participationReady = restoreParticipatingTopics(pi, ctx, state);
    }
    let catalog: CatalogReference | undefined;
    try {
      catalog = buildCatalogReference(state, latestCatalogSnapshot(entries));
      // A prior startup listing may have failed while a later explicit join was
      // recorded. A successful current catalog proves discovery is usable; do
      // not call restore again and erase that in-memory explicit choice.
      state.participationReady = true;
    } catch { state.participationReady = false; }
    const board = state.participationReady
      ? buildBoardDelivery(state.participatingTopics, coverage)
      : unavailableBoardDelivery("Board catalog or participation discovery failed; delivery deferred");
    const activeCritical = activeCriticalKeys(entries, board);
    emitHealthWarning(state, knowledge.issues);
    emitBoardWarning(state, board.warnings ?? []);

    const frozenCatalog = catalog?.changed && freezeReference(
      pi,
      event,
      catalog.content,
      catalog.mode === "checkpoint" ? "board-catalog" : "board-catalog-delta",
      catalog.sourceDigest,
      {
        boardCatalogBytes: Buffer.byteLength(catalog.content, "utf-8"),
        catalogRowDigests: catalog.rowDigestByTopic,
      },
    );
    const catalogUpdate = frozenCatalog && catalog
      ? hiddenMessage(
        // Keep the established customType for existing sessions/extensions;
        // `details.mode` and the XML tag distinguish a compact delta.
        BOARD_CATALOG_MESSAGE_TYPE,
        frozenCatalog,
        {
          kind: catalog.mode === "checkpoint" ? "board-catalog" : "board-catalog-delta",
          mode: catalog.mode,
          catalogRowDigests: catalog.rowDigestByTopic,
        },
      )
      : undefined;

    const frozenKnowledge = freezeReference(
      pi,
      event,
      knowledgeReference.content,
      "knowledge",
      knowledgeReference.sourceDigest,
      { knowledgeBytes: knowledge.bytes },
    );
    const knowledgeUpdate = latestActiveSnapshotId(entries, KNOWLEDGE_MESSAGE_TYPE) === frozenKnowledge.id
      ? undefined
      : hiddenMessage(KNOWLEDGE_MESSAGE_TYPE, frozenKnowledge, { kind: "knowledge" });

    let boardUpdate: any;
    if (board.mode !== "none") {
      const sourceDigest = board.content.match(/source_digest="([a-f0-9]+)"/)?.[1] ?? sha256(board.content);
      const kind = board.mode === "checkpoint" ? "board-checkpoint" : "board-delta";
      const frozenBoard = freezeReference(pi, event, board.content, kind, sourceDigest, {
        boardBytes: board.bytes,
        logicalBoardBytes: board.logicalBytes,
        topicSeqs: board.topicSeqs,
        topicStates: board.topicStates,
        topicIncarnations: board.topicIncarnations,
      });
      boardUpdate = hiddenMessage(
        board.mode === "checkpoint" ? BOARD_CHECKPOINT_MESSAGE_TYPE : BOARD_DELTA_MESSAGE_TYPE,
        frozenBoard,
        {
          kind,
          mode: board.mode,
          topicSeqs: board.topicSeqs,
          topicStates: board.topicStates,
          topicIncarnations: board.topicIncarnations,
        },
      );
      pending.board = boardUpdate;
    }

    const newCritical = board.criticalUpdates.filter(update => !activeCritical.has(update.key));
    let criticalContent = "";
    if (newCritical.length > 0) {
      criticalContent = formatCriticalMessage(newCritical);
      const sources = newCritical.map(update => `Board ${update.topic}#${update.note.seq}`);
      const frozenCritical = freezeReference(
        pi,
        event,
        criticalContent,
        "board-critical",
        sha256(criticalContent),
        {
          boardBytes: Buffer.byteLength(criticalContent, "utf-8"),
          topicSeqs: board.topicSeqs,
          topicStates: board.topicStates,
          topicIncarnations: board.topicIncarnations,
          criticalKeys: newCritical.map(update => update.key),
          sources,
        },
      );
      pending.critical = criticalMessage(newCritical, board, frozenCritical);
    }
    const retainedContent = persistedRuntimeReferenceContent(entries);
    const newBoardContent = [
      catalogUpdate?.content,
      boardUpdate?.content,
      criticalContent,
    ].filter(Boolean).join("\n\n");
    const activeBoardBytes = activeBoardReferenceBytes(entries, metadataEntries)
      + Buffer.byteLength(newBoardContent, "utf-8");
    const injectedContent = [
      retainedContent,
      knowledgeUpdate?.content,
      catalogUpdate?.content,
      boardUpdate?.content,
      criticalContent,
    ].filter(Boolean).join("\n\n");
    if (injectedContent) {
      const injectedBytes = Buffer.byteLength(injectedContent, "utf-8");
      // Keep the warning breakdown disjoint. The residual includes retained
      // legacy references and wrapper/provenance overhead not represented by
      // the current logical knowledge or active Board bytes.
      const retainedReferenceBytes = Math.max(
        0,
        injectedBytes - knowledge.bytes - activeBoardBytes,
      );
      emitSizeWarning(
        state,
        injectedContent,
        knowledge.bytes,
        activeBoardBytes,
        retainedReferenceBytes,
        ctx,
      );
    }
    if (catalogUpdate) pending.catalog = catalogUpdate;
    return knowledgeUpdate ? { message: knowledgeUpdate } : undefined;
  });

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const message = pendingDeliveryByTurn.get(ctx)?.catalog;
    return message ? { message } : undefined;
  });

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const message = pendingDeliveryByTurn.get(ctx)?.board;
    return message ? { message } : undefined;
  });

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const message = pendingDeliveryByTurn.get(ctx)?.critical;
    pendingDeliveryByTurn.delete(ctx);
    return message ? { message } : undefined;
  });
}
