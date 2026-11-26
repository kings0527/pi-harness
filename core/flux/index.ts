import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getStorageRoot } from "../storage/index.ts";
import type { FieldMode } from "../field/index.ts";

export type LensId = "spine" | "seam" | "probe" | "invert" | "scout";

export interface CognitiveLens {
  id: LensId;
  name: string;
  startingBias: string;
}

/**
 * Domain-agnostic starting postures that break initial symmetry across parallel
 * tentacles without pre-partitioning an unknown maze into fixed boundaries.
 * They are explicitly decaying starting biases: live environment feedback
 * always overrides the initial posture.
 */
export const COGNITIVE_LENSES: readonly CognitiveLens[] = [
  {
    id: "spine",
    name: "Spine Trace",
    startingBias:
      "Follow the most direct entry point, main execution path, or primary error chain straight inward to expose the core mechanism.",
  },
  {
    id: "seam",
    name: "Seam Walker",
    startingBias:
      "Bypass thick front walls; inspect boundaries, configs, handoffs, fallback/error branches, and cross-module seams where bypasses hide.",
  },
  {
    id: "probe",
    name: "Empirical Probe",
    startingBias:
      "Minimize static speculation; run small discriminating inputs, scripts, tests, or dynamic checks early to force concrete world feedback.",
  },
  {
    id: "invert",
    name: "Falsifier",
    startingBias:
      "Target the most plausible-looking assumption or early consensus; look for counterexamples, boundary failures, and hidden false negatives.",
  },
  {
    id: "scout",
    name: "Context Scout",
    startingBias:
      "Step back to map surrounding dependencies, environment constraints, history/knowledge entries, and cross-cutting invariants.",
  },
];

export interface ResolvedLens {
  id: string;
  name: string;
  startingBias: string;
}

export function resolveLens(spec: string): ResolvedLens {
  const clean = String(spec ?? "").trim();
  const lower = clean.toLowerCase();
  const builtin = COGNITIVE_LENSES.find(
    (lens) => lens.id === lower || lens.name.toLowerCase() === lower,
  );
  if (builtin) return builtin;
  return {
    id: lower.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "custom",
    name: clean || "Custom Lens",
    startingBias: clean || COGNITIVE_LENSES[0].startingBias,
  };
}

export function pickStartingLenses(count: number, requested?: string[]): ResolvedLens[] {
  const n = Math.max(1, Math.floor(count));
  const out: ResolvedLens[] = [];
  for (let i = 0; i < n; i += 1) {
    if (requested && requested[i]?.trim()) {
      out.push(resolveLens(requested[i]));
    } else {
      out.push(COGNITIVE_LENSES[i % COGNITIVE_LENSES.length]);
    }
  }
  return out;
}

export type FluxConfigScope = "project" | "global";

export interface FluxConfigOptions {
  /** Override home directory used for global `~/.pi-harness/flux.json` (e.g. DSH WSL UNC mapping). */
  globalHome?: string;
}

export interface FluxConfig {
  enabled: boolean;
  models: string[];
  tentacles?: number;
  mode?: FieldMode;
  /** Runtime metadata: false when no explicit project/global config exists yet (default-on). */
  configured?: boolean;
  /** Runtime metadata: where this effective config was resolved from. */
  source?: FluxConfigScope | "default";
}

const FLUX_FILE = "flux.json";

export function getGlobalFluxPath(options: FluxConfigOptions = {}): string {
  const home = options.globalHome?.trim() || process.env.HOME?.trim() || homedir();
  return join(home, ".pi-harness", FLUX_FILE);
}

export function getProjectFluxPath(): string {
  return join(getStorageRoot(), FLUX_FILE);
}

export function hasProjectFluxConfig(): boolean {
  return existsSync(getProjectFluxPath());
}

function cleanModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of models) {
    const trimmed = String(item ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function readConfigFile(path: string, source: FluxConfigScope): FluxConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<FluxConfig>;
    if (!raw || typeof raw !== "object") return null;
    const mode = raw.mode === "worktree" || raw.mode === "shared" ? raw.mode : undefined;
    const tentacles =
      typeof raw.tentacles === "number" && Number.isInteger(raw.tentacles) && raw.tentacles >= 1 && raw.tentacles <= 8
        ? raw.tentacles
        : undefined;
    return {
      enabled: raw.enabled !== false,
      models: cleanModels(raw.models),
      ...(tentacles !== undefined ? { tentacles } : {}),
      ...(mode ? { mode } : {}),
      configured: true,
      source,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve effective Flux config: project override > global user preference > zero-config default-on.
 * Natural-language Flux invocations work out of the box unless explicitly turned off.
 */
export function getFluxConfig(options: FluxConfigOptions = {}): FluxConfig {
  const project = readConfigFile(getProjectFluxPath(), "project");
  if (project) return project;
  const globalCfg = readConfigFile(getGlobalFluxPath(options), "global");
  if (globalCfg) return globalCfg;
  return { enabled: true, models: [], configured: false, source: "default" };
}

export function isFluxDisabled(config: FluxConfig): boolean {
  return config.configured === true && config.enabled === false;
}

export function setFluxConfig(
  config: FluxConfig,
  scope: FluxConfigScope = "project",
  options: FluxConfigOptions = {},
): void {
  const path = scope === "global" ? getGlobalFluxPath(options) : getProjectFluxPath();
  mkdirSync(dirname(path), { recursive: true });
  const persisted: Record<string, unknown> = {
    enabled: config.enabled !== false,
    models: cleanModels(config.models),
    ...(config.tentacles !== undefined ? { tentacles: config.tentacles } : {}),
    ...(config.mode ? { mode: config.mode } : {}),
  };
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(persisted, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

export function clearProjectFluxConfig(): boolean {
  const path = getProjectFluxPath();
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve tentacle model pool while preserving full `provider/id` multi-channel specs.
 * Priority: per-call override > configured pool > active session model > [] (runtime default).
 */
export function resolveFluxModels(
  config: FluxConfig,
  currentModelSpec?: string,
  overrideModels?: string[],
): string[] {
  const override = cleanModels(overrideModels);
  if (override.length > 0) return override;
  const configured = cleanModels(config.models);
  if (configured.length > 0) return configured;
  const active = String(currentModelSpec ?? "").trim();
  if (active) return [active];
  return [];
}
