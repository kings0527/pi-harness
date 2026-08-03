import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getStorageRoot } from "../storage/index.ts";

export interface StormConfig {
  enabled: boolean;
  models: string[];  // e.g. ["claude-sonnet-4", "deepseek-r1"]
}

const STORM_FILE = "storm.json";

export function getStormConfig(): StormConfig {
  const path = join(getStorageRoot(), STORM_FILE);
  if (!existsSync(path)) {
    return { enabled: false, models: [] };
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function setStormConfig(config: StormConfig): void {
  const path = join(getStorageRoot(), STORM_FILE);
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}
