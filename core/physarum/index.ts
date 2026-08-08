import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getStorageRoot } from "../storage/index.ts";

export interface PhysarumConfig {
  enabled: boolean;
  models: string[];
  tentacles?: number;
  maxPulses?: number;
}

const PHYSARUM_FILE = "physarum.json";

export function getPhysarumConfig(): PhysarumConfig {
  const path = join(getStorageRoot(), PHYSARUM_FILE);
  if (!existsSync(path)) {
    return { enabled: false, models: [] };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { enabled: false, models: [] };
  }
}

export function setPhysarumConfig(config: PhysarumConfig): void {
  const path = join(getStorageRoot(), PHYSARUM_FILE);
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmpPath, path);
}
