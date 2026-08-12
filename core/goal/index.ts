import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getStorageRoot } from "../storage/index.ts";

export interface GoalState {
  text: string;
  status: "active" | "paused" | "achieved" | "abandoned";
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  achievedAt?: number;
}

const GOAL_FILE = "goal.json";

export function getGoal(): GoalState | null {
  const path = join(getStorageRoot(), GOAL_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`[goal] Invalid goal.json at ${path}: ${(err as Error).message}`);
    return null;
  }
}

export function setGoal(text: string): GoalState {
  const state: GoalState = {
    text,
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    turnCount: 0,
  };
  persist(state);
  return state;
}

export function updateGoal(patch: Partial<GoalState>): GoalState | null {
  const current = getGoal();
  if (!current) return null;
  const updated = { ...current, ...patch, updatedAt: Date.now() };
  persist(updated);
  return updated;
}

export function clearGoal(): void {
  const path = join(getStorageRoot(), GOAL_FILE);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function persist(state: GoalState): void {
  const path = join(getStorageRoot(), GOAL_FILE);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, path);
}
