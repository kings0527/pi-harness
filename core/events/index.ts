import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getStorageRoot } from "../storage/index.ts";

export interface SystemEvent {
  type: string;
  timestamp: number;
  details: Record<string, unknown>;
}

export function appendEvent(type: string, details: Record<string, unknown>): void {
  const event: SystemEvent = {
    type,
    timestamp: Date.now(),
    details,
  };
  const eventsPath = join(getStorageRoot(), "events.jsonl");
  appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf-8");
}
