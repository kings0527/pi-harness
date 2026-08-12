import { createHash } from "node:crypto";
import { listTopics } from "../core/board/index.ts";
import {
  buildBoardSnapshot,
  buildKnowledgeSnapshot,
  buildReferenceContent,
  formatCriticalMessage,
  type BoardSnapshot,
  type CriticalUpdate,
  type KnowledgeSnapshot,
} from "../core/context-reference/index.ts";
import { assessContextSize } from "../core/context-size/index.ts";
import { writeContextSnapshot } from "../core/context-snapshot/index.ts";
import { appendEvent } from "../core/events/index.ts";
import { discoverScopes, findKnowledgeScope, type ScopeEntry } from "../core/knowledge/scope.ts";

const REFERENCE_MESSAGE_TYPE = "pi-harness-reference";
const CRITICAL_MESSAGE_TYPE = "pi-harness-board-critical";
const participatingTopics = new Set<string>();
const announcedCriticalNotes = new Set<string>();
const activeKnowledgeScopes = new Set<string>();
let scopeCache: Map<string, ScopeEntry> = new Map();
let lastSizeWarningKey: string | null = null;
let lastHealthWarningKey: string | null = null;

const SCOPE_ACTIVATING_TOOLS = new Set(["read", "read_file", "edit", "write", "edit_file", "write_file"]);
const SCOPE_IGNORE_BASENAMES = new Set(["package.json", "package-lock.json", "tsconfig.json", ".gitignore", "README.md", "KNOWLEDGE.md", "LICENSE"]);

interface FrozenReference {
  id: string;
  path: string;
  content: string;
  bytes: number;
  knowledgeBytes: number;
  boardBytes: number;
  topicSeqs: Record<string, number>;
  frozenAt: number;
}

let frozenReference: FrozenReference | null = null;

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
    appendEvent("hook_warn", {
      rule: "knowledge-index-health",
      issues,
      message,
    });
  } catch {
    // Warning persistence is best-effort; reference delivery remains intact.
  }
}

function emitSizeWarning(
  injectedContent: string,
  knowledgeBytes: number,
  boardBytes: number,
  ctx: any,
): void {
  const contextWindow = contextWindowFrom(ctx);
  if (!contextWindow) return;

  const assessment = assessContextSize(injectedContent, contextWindow);
  if (!assessment.shouldWarn) {
    lastSizeWarningKey = null;
    return;
  }

  // Warn once per continuous over-threshold episode for the active window.
  const key = String(contextWindow);
  if (key === lastSizeWarningKey) return;
  lastSizeWarningKey = key;

  const percent = (assessment.ratio * 100).toFixed(1);
  const knowledgeTokens = Math.ceil(knowledgeBytes / 3);
  const boardTokens = Math.ceil(boardBytes / 3);
  const message = `Full context preserved: ~${assessment.estimatedTokens} tokens (${percent}% of ${contextWindow}); knowledge ~${knowledgeTokens}, Board ~${boardTokens}. Review active project/workspace/global knowledge indexes and open Board topics for stale, incorrect, duplicate, or overly verbose content.`;
  console.error(`[context-feed] WARN: ${message}`);
  try {
    appendEvent("hook_warn", {
      rule: "context-injection-size",
      ...assessment,
      knowledgeBytes,
      boardBytes,
      message,
    });
  } catch {
    // Warning persistence is best-effort; reference delivery remains intact.
  }
}

function freezeReference(
  pi: any,
  event: any,
  knowledge: KnowledgeSnapshot,
  board: BoardSnapshot,
): FrozenReference | null {
  const { content, sourceDigest } = buildReferenceContent(knowledge, board);
  if (!content) return null;
  const file = writeContextSnapshot(content);
  const snapshot: FrozenReference = {
    ...file,
    content,
    knowledgeBytes: knowledge.bytes,
    boardBytes: board.bytes,
    topicSeqs: board.topicSeqs,
    frozenAt: Date.now(),
  };

  const metadata = {
    snapshotId: snapshot.id,
    sourceDigest,
    path: snapshot.path,
    bytes: snapshot.bytes,
    knowledgeBytes: snapshot.knowledgeBytes,
    boardBytes: snapshot.boardBytes,
    topicSeqs: snapshot.topicSeqs,
    promptDigest: sha256(String(event?.prompt ?? "")),
    frozenAt: snapshot.frozenAt,
  };
  pi.appendEntry?.("pi-harness-context-snapshot", metadata);
  try {
    appendEvent("context_snapshot", metadata);
  } catch {
    // The content-addressed snapshot file remains the source of truth.
  }
  return snapshot;
}

function referenceMessage(snapshot: FrozenReference): any {
  return {
    role: "custom",
    customType: REFERENCE_MESSAGE_TYPE,
    content: snapshot.content,
    display: false,
    details: {
      snapshotId: snapshot.id,
      path: snapshot.path,
      bytes: snapshot.bytes,
      frozenAt: snapshot.frozenAt,
    },
    timestamp: snapshot.frozenAt,
  };
}

function restoreAnnouncedCriticalNotes(ctx: any): void {
  const entries = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (entry?.type === "custom_message") rememberCriticalMessage({ role: "custom", ...entry });
  }
}

function rememberCriticalMessage(message: any): void {
  if (message?.role !== "custom" || message.customType !== CRITICAL_MESSAGE_TYPE) return;
  const sources = message.details?.sources;
  if (!Array.isArray(sources)) return;
  for (const source of sources) {
    if (typeof source === "string" && source.startsWith("Board ")) {
      announcedCriticalNotes.add(source.slice("Board ".length));
    }
  }
}

export default async function (pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    participatingTopics.clear();
    announcedCriticalNotes.clear();
    activeKnowledgeScopes.clear();
    frozenReference = null;
    lastSizeWarningKey = null;
    lastHealthWarningKey = null;
    restoreAnnouncedCriticalNotes(ctx);
    try {
      scopeCache = discoverScopes(process.cwd(), 8);
    } catch {
      scopeCache = new Map();
    }
    try {
      for (const topic of listTopics()) {
        if (topic.status === "open") participatingTopics.add(topic.id);
      }
    } catch {
      // Board storage may not exist before its first use.
    }
  });

  pi.on("tool_result", async (event: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName !== "board") return;
    const input = event.input || event.args || {};
    if ((input.action === "open" || input.action === "post") && input.topic) {
      participatingTopics.add(input.topic);
    }
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

  pi.on("message_end", async (event: any) => {
    rememberCriticalMessage(event.message);
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const knowledge = buildKnowledgeSnapshot([...activeKnowledgeScopes]);
    const board = buildBoardSnapshot(participatingTopics);
    emitHealthWarning(knowledge.issues);

    // A new user prompt is the sole refresh boundary for passive reference data.
    frozenReference = freezeReference(pi, event, knowledge, board);

    const newCritical = board.criticalUpdates.filter(update => !announcedCriticalNotes.has(update.key));
    const criticalContent = newCritical.length > 0 ? formatCriticalMessage(newCritical) : "";
    const injectedContent = [frozenReference?.content, criticalContent].filter(Boolean).join("\n\n");
    const criticalBytes = Buffer.byteLength(criticalContent, "utf-8");
    if (injectedContent) {
      emitSizeWarning(injectedContent, knowledge.bytes, board.bytes + criticalBytes, ctx);
    }

    if (newCritical.length === 0) return;
    return {
      message: {
        customType: CRITICAL_MESSAGE_TYPE,
        content: criticalContent,
        display: true,
        details: {
          sources: newCritical.map(update => `Board ${update.topic}#${update.note.seq}`),
        },
      },
    };
  });

  pi.on("context", async (event: any) => {
    if (!frozenReference || !Array.isArray(event.messages)) return {};

    // Context events receive a deep copy. Insert one distinct reference message
    // immediately before the current real user prompt without mutating its bytes.
    const messages = event.messages.filter(
      (message: any) => !(message.role === "custom" && message.customType === REFERENCE_MESSAGE_TYPE),
    );
    let insertionIndex = messages.findLastIndex((message: any) => message.role === "user");
    if (insertionIndex < 0) insertionIndex = messages.length;
    messages.splice(insertionIndex, 0, referenceMessage(frozenReference));
    return { messages };
  });
}
