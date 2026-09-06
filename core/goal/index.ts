import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { readNotes } from "../board/index.ts";
import type { Note } from "../board/types.ts";
import { writeContextSnapshot, type ContextSnapshotFile } from "../context-snapshot/index.ts";
import { boundedEscapedXmlText, boundedIntEnv } from "../text-budget/index.ts";
import { appendEvent } from "../events/index.ts";
import { ensureDir, getStorageRoot } from "../storage/index.ts";

export const GOAL_MET_TAG = "goal-met";
export const GOAL_AUTO_CONTINUE_LIMIT = 4;

export interface GoalEvidence {
  topic: string;
  noteSeq: number;
  noteTimestamp: number;
}

export interface GoalState {
  id: string;
  sessionId: string;
  text: string;
  status: "active" | "paused" | "achieved";
  createdAt: number;
  updatedAt: number;
  userTurnCount: number;
  achievedAt?: number;
  evidence?: GoalEvidence;
}

export interface GoalReferenceSnapshot extends ContextSnapshotFile {
  goalId: string;
  sessionId: string;
  userTurnCount: number;
  content: string;
  frozenAt: number;
}

function requireSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) throw new Error("sessionId is required");
  return trimmed;
}

function storageKey(sessionId: string): string {
  const raw = requireSessionId(sessionId);
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safe === raw && safe.length <= 128) return safe;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const prefix = (safe || "session").slice(0, 111);
  return `${prefix}-${digest}`;
}

function goalsDirectory(): string {
  return join(getStorageRoot(), "goals");
}

export function getGoalFilePath(sessionId: string): string {
  return join(goalsDirectory(), `${storageKey(sessionId)}.json`);
}

function isGoalState(value: unknown, sessionId: string): value is GoalState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<GoalState>;
  return typeof state.id === "string"
    && state.sessionId === sessionId
    && typeof state.text === "string"
    && ["active", "paused", "achieved"].includes(String(state.status))
    && typeof state.createdAt === "number"
    && typeof state.updatedAt === "number"
    && Number.isInteger(state.userTurnCount)
    && (state.userTurnCount ?? -1) >= 0;
}

export function getGoal(sessionId: string): GoalState | null {
  const normalizedSessionId = requireSessionId(sessionId);
  const path = getGoalFilePath(normalizedSessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isGoalState(parsed, normalizedSessionId)) throw new Error("schema or session mismatch");
    return parsed;
  } catch (error) {
    console.error(`[goal] Invalid goal state at ${path}: ${(error as Error).message}`);
    return null;
  }
}

export function setGoal(sessionId: string, text: string): GoalState {
  const normalizedSessionId = requireSessionId(sessionId);
  const objective = text.trim();
  if (!objective) throw new Error("goal text is required");
  const previous = getGoal(normalizedSessionId);
  const now = Date.now();
  const state: GoalState = {
    id: randomUUID(),
    sessionId: normalizedSessionId,
    text: objective,
    status: "active",
    createdAt: now,
    updatedAt: now,
    userTurnCount: 0,
  };
  persist(state);
  if (previous) {
    appendEvent("goal_replaced", {
      sessionId: normalizedSessionId,
      previousGoalId: previous.id,
      previous: goalEventText(previous.text),
      nextGoalId: state.id,
    });
  }
  appendEvent("goal_set", { sessionId: normalizedSessionId, goalId: state.id, ...goalEventText(state.text) });
  return state;
}

export function pauseGoal(sessionId: string): GoalState | null {
  const current = getGoal(sessionId);
  if (!current || current.status !== "active") return null;
  const updated = persistPatch(current, { status: "paused" });
  appendEvent("goal_paused", { sessionId: current.sessionId, goalId: current.id });
  return updated;
}

export function resumeGoal(sessionId: string): GoalState | null {
  const current = getGoal(sessionId);
  if (!current || current.status !== "paused") return null;
  const updated = persistPatch(current, { status: "active" });
  appendEvent("goal_resumed", { sessionId: current.sessionId, goalId: current.id });
  return updated;
}

/** Advance exactly once from the per-user-prompt before_agent_start boundary. */
export function beginGoalTurn(sessionId: string, expectedGoalId: string): GoalState | null {
  const current = getGoal(sessionId);
  if (!current || current.status !== "active" || current.id !== expectedGoalId) return null;
  return persistPatch(current, { userTurnCount: current.userTurnCount + 1 });
}

/**
 * Advance exactly once for one real user prompt. A registered echo prompt
 * (the /goal command re-submitted by the handler itself) is consumed and
 * skipped once: the command turn is goal setup, not goal work.
 */
export function beginGoalTurnOnce(
  sessionId: string,
  expectedGoalId: string,
  prompt?: string,
): GoalState | null {
  const current = getGoal(sessionId);
  if (!current || current.status !== "active" || current.id !== expectedGoalId) return null;
  const key = echoPromptKey(sessionId, current.id, prompt);
  if (consumedEchoPrompts.has(key)) {
    consumedEchoPrompts.delete(key);
    return null;
  }
  return persistPatch(current, { userTurnCount: current.userTurnCount + 1 });
}

/**
 * Register the re-submitted /goal command turn so its first
 * before_agent_start does not double-count as goal work. Registered before
 * pi.sendUserMessage so the echo turn is the one that consumes it.
 */
export function registerEchoPrompt(sessionId: string, goalId: string, prompt: string): void {
  consumedEchoPrompts.add(echoPromptKey(sessionId, goalId, prompt));
  // FIFO-evict the oldest entries (Set iterates in insertion order) so a
  // just-registered echo is never evicted before its turn consumes it.
  while (consumedEchoPrompts.size > 512) {
    const oldest = consumedEchoPrompts.values().next().value;
    if (oldest === undefined) break;
    consumedEchoPrompts.delete(oldest);
  }
}

function echoPromptKey(sessionId: string, goalId: string, prompt?: string): string {
  return `${sessionId}\n${goalId}\n${typeof prompt === "string" ? prompt : ""}`;
}

// Prompts whose first before_agent_start has already been consumed by an
// extension-originated re-submission. Bounded per process (Pi is long-lived;
// the set resets with the runtime, not per session).
const consumedEchoPrompts = new Set<string>();

export function goalEvidenceTag(goalId: string): string {
  return `goal:${goalId}`;
}

/** Verify the exact persisted Board note before the runtime writes the completion marker. */
export function completeGoalFromBoardNote(
  sessionId: string,
  expectedGoalId: string,
  topic: string,
  noteSeq: number,
): GoalState | null {
  const current = getGoal(sessionId);
  if (!current || current.status !== "active" || current.id !== expectedGoalId) return null;
  if (!topic || !Number.isInteger(noteSeq) || noteSeq <= 0) return null;

  let note: Note | undefined;
  try {
    note = readNotes(topic).find(candidate => candidate.seq === noteSeq);
  } catch {
    return null;
  }
  const tags = note?.tags;
  if (!note || !note.content.trim() || !Array.isArray(tags)) return null;
  if (!tags.includes(GOAL_MET_TAG) || !tags.includes(goalEvidenceTag(current.id))) return null;

  const achievedAt = Date.now();
  const evidence: GoalEvidence = { topic, noteSeq: note.seq, noteTimestamp: note.timestamp };
  const updated = persistPatch(current, { status: "achieved", achievedAt, evidence });
  appendEvent("goal_achieved", {
    sessionId: current.sessionId,
    goalId: current.id,
    ...goalEventText(current.text),
    userTurnCount: current.userTurnCount,
    evidence,
    achievedAt,
  });
  return updated;
}

export function clearGoal(sessionId: string): GoalState | null {
  const current = getGoal(sessionId);
  if (!current) return null;
  const path = getGoalFilePath(current.sessionId);
  if (existsSync(path)) unlinkSync(path);
  appendEvent("goal_cleared", {
    sessionId: current.sessionId,
    goalId: current.id,
    ...goalEventText(current.text),
    status: current.status,
    userTurnCount: current.userTurnCount,
  });
  return current;
}

function goalEventText(text: string): { textBytes: number; textDigest: string } {
  return {
    textBytes: Buffer.byteLength(text, "utf-8"),
    textDigest: createHash("sha256").update(text, "utf-8").digest("hex"),
  };
}

function renderedGoalText(goal: GoalState): string {
  return boundedEscapedXmlText(
    goal.text,
    boundedIntEnv("PI_GOAL_REFERENCE_TEXT_BYTES", 8192),
    `/goal status or ${getGoalFilePath(goal.sessionId)}`,
  );
}

export function renderGoalReference(goal: GoalState): string {
  const evidenceTag = goalEvidenceTag(goal.id);
  return [
    `<active_goal id="${goal.id}" scope="current-session">`,
    "<instruction>This is the persistent execution target for the current session. Every action should serve it.</instruction>",
    "<execution_policy>Work autonomously within the stated goal and existing permissions until achieved. When several viable routes exist, choose the best evidence-backed, reversible route and execute it; do not stop to ask the user to pick or merely offer next steps. Request user input only when every meaningful route is blocked by essential information or permission that cannot be inferred or obtained. Otherwise state assumptions and keep working.</execution_policy>",
    `<objective>${renderedGoalText(goal)}</objective>`,
    `<completion required_tags="${GOAL_MET_TAG} ${evidenceTag}">When fully achieved, post a Board note containing completion evidence with both required tags.</completion>`,
    "</active_goal>",
  ].join("\n");
}

/**
 * Whether an ended agent turn should be resumed automatically toward the
 * active goal. Pure policy so the extension stays a thin wiring layer.
 */
export function shouldAutoContinueGoal(
  goal: GoalState | null,
  stopReason: string | undefined,
  autoContinuesUsed: number,
  limit: number = GOAL_AUTO_CONTINUE_LIMIT,
): boolean {
  if (!goal || goal.status !== "active") return false;
  if (stopReason === "error" || stopReason === "aborted") return false;
  return autoContinuesUsed < limit;
}

/**
 * Steer payload re-asserting the objective after a reporting turn ended.
 * Not a new user request: it only re-activates the same execution policy.
 */
export function renderGoalContinueMessage(goal: GoalState, attempt: number, limit: number): string {
  const evidenceTag = goalEvidenceTag(goal.id);
  return [
    `<goal_continue id="${goal.id}" scope="current-session" attempt="${attempt}" limit="${limit}">`,
    "<instruction>This is an automatic continuation, not a new user request. The active goal is not achieved yet: keep working toward it instead of stopping to report progress.</instruction>",
    `<objective>${renderedGoalText(goal)}</objective>`,
    `<completion required_tags="${GOAL_MET_TAG} ${evidenceTag}">When fully achieved, post a Board note containing completion evidence with both required tags.</completion>`,
    "<blocker>If every meaningful route is blocked by missing information or permissions, state exactly what is missing and stop; do not fabricate progress.</blocker>",
    "</goal_continue>",
  ].join("\n");
}

export function createGoalReferenceSnapshot(goal: GoalState): GoalReferenceSnapshot {
  const content = renderGoalReference(goal);
  const file = writeContextSnapshot(content);
  return {
    ...file,
    goalId: goal.id,
    sessionId: goal.sessionId,
    userTurnCount: goal.userTurnCount,
    content,
    frozenAt: Date.now(),
  };
}

function persistPatch(current: GoalState, patch: Partial<GoalState>): GoalState {
  const updated: GoalState = { ...current, ...patch, id: current.id, sessionId: current.sessionId, updatedAt: Date.now() };
  persist(updated);
  return updated;
}

function persist(state: GoalState): void {
  const directory = goalsDirectory();
  ensureDir(directory);
  const path = getGoalFilePath(state.sessionId);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { encoding: "utf-8", flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}
