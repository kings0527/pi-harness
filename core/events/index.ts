import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getStorageRoot } from "../storage/index.ts";

export interface SystemEvent {
  type: string;
  timestamp: number;
  details: Record<string, unknown>;
}

/**
 * root is the project/session cwd; evidence lands in <root>/.pi-board/events.jsonl.
 * Defaults to the process-cwd anchor from core/storage. Extensions that
 * operate on a session cwd (ctx.cwd) must pass it explicitly so audit
 * evidence lands in the same repo that was inspected, never in a stale
 * process-cwd anchor.
 */
export function appendEvent(type: string, details: Record<string, unknown>, root?: string): void {
  const event: SystemEvent = {
    type,
    timestamp: Date.now(),
    details,
  };
  const eventsPath = root
    ? join(root, ".pi-board", "events.jsonl")
    : join(getStorageRoot(), "events.jsonl");
  // The explicit-root path may point at a worktree whose .pi-board was
  // deleted while the files remained in the Git index — create the dir
  // before appending instead of crashing with ENOENT.
  if (root) mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf-8");
}
