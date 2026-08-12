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
import { appendEvent } from "../events/index.ts";
import { ensureDir, getStorageRoot } from "../storage/index.ts";

export const GOAL_MET_TAG = "goal-met";

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
      previousText: previous.text,
      nextGoalId: state.id,
    });
  }
  appendEvent("goal_set", { sessionId: normalizedSessionId, goalId: state.id, text: state.text });
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
    text: current.text,
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
    text: current.text,
    status: current.status,
    userTurnCount: current.userTurnCount,
  });
  return current;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderGoalReference(goal: GoalState): string {
  const evidenceTag = goalEvidenceTag(goal.id);
  return [
    `<active_goal id="${escapeXml(goal.id)}" scope="current-session">`,
    "<instruction>This is the persistent execution target for the current session. Every action should serve it.</instruction>",
    "<execution_policy>Work autonomously within the stated goal and existing permissions until achieved. When several viable routes exist, choose the best evidence-backed, reversible route and execute it; do not stop to ask the user to pick or merely offer next steps. Request user input only when every meaningful route is blocked by essential information or permission that cannot be inferred or obtained. Otherwise state assumptions and keep working.</execution_policy>",
    `<objective>${escapeXml(goal.text)}</objective>`,
    `<completion required_tags="${GOAL_MET_TAG} ${escapeXml(evidenceTag)}">When fully achieved, post a Board note containing completion evidence with both required tags.</completion>`,
    "</active_goal>",
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
