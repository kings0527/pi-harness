import { createHash } from "node:crypto";
import { listOpenTopics } from "../core/board/index.ts";
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
const CRITICAL_MESSAGE_TYPE = "pi-harness-board-critical";
const CONTEXT_SNAPSHOT_ENTRY_TYPE = "pi-harness-context-snapshot";
const BOARD_PARTICIPATION_ENTRY_TYPE = "pi-harness-board-participation";
const RUNTIME_REFERENCE_TYPES = new Set([
  LEGACY_REFERENCE_MESSAGE_TYPE,
  KNOWLEDGE_MESSAGE_TYPE,
  BOARD_CHECKPOINT_MESSAGE_TYPE,
  BOARD_DELTA_MESSAGE_TYPE,
  CRITICAL_MESSAGE_TYPE,
]);

const activeKnowledgeScopes = new Set<string>();
const participatingTopics = new Set<string>();
let pendingDeliveryByTurn = new WeakMap<object, { board?: any; critical?: any }>();
let participationReady = false;
let lastSizeWarningKey: string | null = null;
let lastHealthWarningKey: string | null = null;
let lastBoardWarningKey: string | null = null;

const SCOPE_ACTIVATING_TOOLS = new Set(["read", "read_file", "edit", "write", "edit_file", "write_file"]);
const SCOPE_IGNORE_BASENAMES = new Set(["package.json", "package-lock.json", "tsconfig.json", ".gitignore", "README.md", "KNOWLEDGE.md", "LICENSE"]);

interface FrozenReference {
  id: string;
  path: string;
  content: string;
  bytes: number;
  frozenAt: number;
  kind: "knowledge" | "board-checkpoint" | "board-delta" | "board-critical";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function contextWindowFrom(ctx: any): number | null {
  const value = ctx?.model?.contextWindow ?? ctx?.getContextUsage?.()?.contextWindow;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function emitHealthWarning(issues: KnowledgeSnapshot["issues"]): void {
  if (issues.length === 0) {
    lastHealthWarningKey = null;
    return;
  }
  const details = issues
    .map(({ scope, issue }) => `${scope}:${issue.path} (${issue.reason}${issue.detail ? `: ${issue.detail}` : ""})`)
    .join("; ");
  const key = sha256(details);
  if (key === lastHealthWarningKey) return;
  lastHealthWarningKey = key;

  const message = `Knowledge index health check found stale/invalid rows: ${details}. Review the selected index and remove or repair only confirmed obsolete entries; no automatic cleanup was performed.`;
  console.error(`[context-feed] WARN: ${message}`);
  try {
    appendEvent("hook_warn", { rule: "knowledge-index-health", issues, message });
  } catch {
    // Warning persistence is best-effort; reference delivery remains intact.
  }
}

function emitBoardWarning(warnings: readonly string[]): void {
  if (warnings.length === 0) {
    lastBoardWarningKey = null;
    return;
  }
  const details = warnings.join("; ");
  const key = sha256(details);
  if (key === lastBoardWarningKey) return;
  lastBoardWarningKey = key;
  const message = `Board delivery notice: ${details}. Source files were preserved; any deferred read will retry on the next turn.`;
  console.error(`[context-feed] WARN: ${message}`);
  try {
    appendEvent("hook_warn", { rule: "board-delivery-read-failed", warnings, message });
  } catch {
    // The append-only Board files remain the source of truth.
  }
}

function emitSizeWarning(
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
    lastSizeWarningKey = null;
    return;
  }
  const key = String(contextWindow);
  if (key === lastSizeWarningKey) return;
  lastSizeWarningKey = key;

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

function restoreParticipatingTopics(pi: any, ctx: any): boolean {
  participatingTopics.clear();
  const entries = activeEntries(ctx);
  const branch = ctx?.sessionManager?.getBranch?.();
  const history = Array.isArray(branch) ? branch : entries;
  let hasPersistedInitialization = false;

  for (const entry of history) {
    if (entry?.type !== "custom" || entry.customType !== BOARD_PARTICIPATION_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!data || typeof data !== "object") continue;
    if (data.action === "initialize" && Array.isArray(data.topics)) {
      hasPersistedInitialization = true;
      for (const topic of data.topics) {
        if (typeof topic === "string" && topic.length > 0) participatingTopics.add(topic);
      }
    } else if (data.action === "join" && typeof data.topic === "string" && data.topic.length > 0) {
      participatingTopics.add(data.topic);
    }
  }

  // ADR-0018 messages predate the explicit participation entry. Their cursor
  // metadata is enough to rebuild the same visibility set on resume.
  const historicalCoverage = deriveBoardCoverage(activeBoardDeliveryDetails(history, history));
  if (historicalCoverage.hasCheckpoint) {
    hasPersistedInitialization = true;
    for (const topic of Object.keys(historicalCoverage.topicStates)) participatingTopics.add(topic);
  }
  if (hasPersistedInitialization) return true;

  // Preserve the original join behavior for a genuinely new session: topics
  // already open when the session starts are the topics this agent joins.
  try {
    for (const topic of listOpenTopics()) participatingTopics.add(topic.id);
  } catch {
    // Do not persist an empty visibility set when the source could not be
    // listed. The first turn retries instead of silently losing participation.
    return false;
  }
  pi.appendEntry?.(BOARD_PARTICIPATION_ENTRY_TYPE, {
    action: "initialize",
    topics: [...participatingTopics].sort(),
    joinedAt: Date.now(),
  });
  return true;
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
    activeKnowledgeScopes.clear();
    pendingDeliveryByTurn = new WeakMap();
    lastSizeWarningKey = null;
    lastHealthWarningKey = null;
    lastBoardWarningKey = null;
    participationReady = restoreParticipatingTopics(pi, ctx);
  });

  pi.on("tool_result", async (event: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName !== "board" || event.isError === true) return;
    const input = event.input || event.args || {};
    if ((input.action !== "open" && input.action !== "post")
      || typeof input.topic !== "string"
      || input.topic.length === 0
      || participatingTopics.has(input.topic)) return;
    participatingTopics.add(input.topic);
    pi.appendEntry?.(BOARD_PARTICIPATION_ENTRY_TYPE, {
      action: "join",
      topic: input.topic,
      joinedAt: Date.now(),
    });
  });

  pi.on("tool_call", async (event: any) => {
    const toolName = (event.tool || event.toolName || "").toLowerCase();
    if (!SCOPE_ACTIVATING_TOOLS.has(toolName)) return;
    const input = event.input || event.args || {};
    const filePath: string | undefined = input.file_path || input.path;
    if (!filePath) return;
    const basename = filePath.split("/").pop() || "";
    if (SCOPE_IGNORE_BASENAMES.has(basename)) return;
    if (filePath.includes("node_modules/") || filePath.includes(".git/")) return;
    const scopeDir = findKnowledgeScope(filePath, process.cwd());
    if (scopeDir) activeKnowledgeScopes.add(scopeDir);
  });

  // First handler plans one user-turn delivery and emits the independent
  // knowledge message. Later handlers persist Board delta and CRITICAL updates.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const pending: { board?: any; critical?: any } = {};
    pendingDeliveryByTurn.set(ctx, pending);
    const entries = activeEntries(ctx);
    const branch = ctx?.sessionManager?.getBranch?.();
    const metadataEntries = Array.isArray(branch) ? branch : entries;
    const knowledge = buildKnowledgeSnapshot([...activeKnowledgeScopes]);
    const knowledgeReference = buildKnowledgeReference(knowledge);
    const coverage = deriveBoardCoverage(activeBoardDeliveryDetails(entries, metadataEntries));
    if (!participationReady) participationReady = restoreParticipatingTopics(pi, ctx);
    const board = participationReady
      ? buildBoardDelivery(participatingTopics, coverage)
      : unavailableBoardDelivery("Board participation initialization failed; delivery deferred");
    const activeCritical = activeCriticalKeys(entries, board);
    emitHealthWarning(knowledge.issues);
    emitBoardWarning(board.warnings ?? []);

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
      boardUpdate?.content,
      criticalContent,
    ].filter(Boolean).join("\n\n");
    const activeBoardBytes = activeBoardReferenceBytes(entries, metadataEntries)
      + Buffer.byteLength(newBoardContent, "utf-8");
    const injectedContent = [
      retainedContent,
      knowledgeUpdate?.content,
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
        injectedContent,
        knowledge.bytes,
        activeBoardBytes,
        retainedReferenceBytes,
        ctx,
      );
    }
    return knowledgeUpdate ? { message: knowledgeUpdate } : undefined;
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
