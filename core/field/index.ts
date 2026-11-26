import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getStorageRoot } from "../storage/index.ts";

export type FieldMode = "shared" | "worktree";
export type FieldStatus = "active" | "breached" | "closed";
export type PulseKind = "echo" | "need" | "conflict" | "breach" | "artifact";

export interface FieldMeta {
  version: 1;
  id: string;
  goal: string;
  topic?: string;
  mode: FieldMode;
  status: FieldStatus;
  rootCwd: string;
  createdBy?: string;
  createdAt: number;
  closedAt?: number;
  breachedAt?: number;
  breachedBy?: string;
  breachSeq?: number;
}

export interface ActorPresence {
  actorId: string;
  label: string;
  lens?: string;
  pid: number;
  processStart: string | null;
  hostTag: string;
  cwd: string;
  heading: string;
  focusArea?: string;
  recentTargets: string[];
  stepCount: number;
  lastTool?: string;
  lastToolError?: boolean;
  updatedAt: number;
  status: "active" | "idle" | "done";
}

export interface ResourceLease {
  resource: string;
  holderId: string;
  holderLabel: string;
  pid: number;
  processStart: string | null;
  hostTag: string;
  purpose: string;
  acquiredAt: number;
  updatedAt: number;
}

export interface ResourceClaimResult {
  acquired: boolean;
  lease: ResourceLease;
}

export interface FieldPulse {
  seq: number;
  timestamp: number;
  actorId: string;
  actorLabel: string;
  lens?: string;
  kind: PulseKind;
  fact: string;
  anchor?: string;
  next?: string;
}

export interface PostPulseInput {
  actorId: string;
  actorLabel?: string;
  lens?: string;
  kind?: PulseKind;
  fact: string;
  anchor?: string;
  next?: string;
}

export interface SidelineCursor {
  lastPulseSeq: number;
  lastResourcesSig: string;
  lastPeersSig: string;
  lastOverlapSig: string;
  seenBreachSeqs: number[];
}

export interface OverlapHit {
  peerId: string;
  peerLabel: string;
  peerLens?: string;
  target: string;
  ageSec: number;
}

export interface SidelineDelta {
  text: string;
  nextCursor: SidelineCursor;
  newPulses: FieldPulse[];
  hasBreach: boolean;
  breachPulses: FieldPulse[];
  livePeers: ActorPresence[];
  resources: ResourceLease[];
  overlaps: OverlapHit[];
}

export interface ToolTraceSummary {
  heading: string;
  targets: string[];
  focusArea?: string;
}

interface LockRecord {
  version: 1;
  pid: number;
  processStart: string | null;
  hostTag: string;
  token: string;
  acquiredAt: number;
}

export const PULSE_KINDS: readonly PulseKind[] = [
  "echo",
  "need",
  "conflict",
  "breach",
  "artifact",
];

const CROSS_HOST_STALE_MS = 10 * 60 * 1000;
const SAME_HOST_PRESENCE_STALE_MS = 30 * 60 * 1000;
const LOCK_TIMEOUT_MS = 5000;
const MAX_RECENT_TARGETS = 8;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

function currentHostTag(): string {
  return `${process.platform}:${hostname()}`;
}

function processStartIdentity(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf-8").trim();
    const closeParen = raw.lastIndexOf(")");
    if (closeParen === -1) return null;
    const rest = raw.slice(closeParen + 2).split(" ");
    // Field 22 in /proc/[pid]/stat (1-indexed) is starttime -> index 19 after ') '.
    return rest[19] ? `linux-start:${rest[19]}` : null;
  } catch {
    return null;
  }
}

function ownerIsProvablyDead(
  pid: number,
  processStart: string | null,
  hostTag: string | undefined,
  updatedAt?: number,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (hostTag && hostTag !== currentHostTag()) {
    // Foreign OS / WSL <-> Windows PID namespace: never probe PID locally.
    if (typeof updatedAt === "number" && Date.now() - updatedAt > CROSS_HOST_STALE_MS) {
      return true;
    }
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    return error?.code === "ESRCH";
  }
  if (processStart?.startsWith("linux-start:")) {
    const current = processStartIdentity(pid);
    return current !== null && current !== processStart;
  }
  return false;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sha256Short(value: string, len = 10): string {
  return createHash("sha256").update(value, "utf-8").digest("hex").slice(0, len);
}

function oneLine(value: string, maxChars = 220): string {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(0, maxChars - 1))}…`;
}

function safeFileKey(raw: string): string {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  const hash = sha256Short(String(raw ?? ""), 8);
  return `${cleaned || "item"}-${hash}`;
}

export function assertFieldId(fieldId: string): void {
  if (
    typeof fieldId !== "string" ||
    fieldId.length === 0 ||
    /[\\/\0]/.test(fieldId) ||
    fieldId === "." ||
    fieldId === ".." ||
    fieldId.startsWith(".")
  ) {
    throw new Error("Field ID must be a non-empty single path segment without slashes or leading dot");
  }
}

export function resolveFieldStorageRoot(overrideRoot?: string): string {
  const root = overrideRoot?.trim() || process.env.PI_FIELD_ROOT?.trim() || getStorageRoot();
  ensureDir(root);
  return root;
}

export function fieldsDir(storageRoot?: string): string {
  const dir = join(resolveFieldStorageRoot(storageRoot), "fields");
  ensureDir(dir);
  return dir;
}

export function fieldDir(fieldId: string, storageRoot?: string): string {
  assertFieldId(fieldId);
  return join(fieldsDir(storageRoot), fieldId);
}

function metaPath(fieldId: string, storageRoot?: string): string {
  return join(fieldDir(fieldId, storageRoot), "meta.json");
}

function pulsesPath(fieldId: string, storageRoot?: string): string {
  return join(fieldDir(fieldId, storageRoot), "pulses.jsonl");
}

function presenceDir(fieldId: string, storageRoot?: string): string {
  return join(fieldDir(fieldId, storageRoot), "presence");
}

function resourcesDir(fieldId: string, storageRoot?: string): string {
  return join(fieldDir(fieldId, storageRoot), "resources");
}

export function artifactsDir(fieldId: string, storageRoot?: string): string {
  const dir = join(fieldDir(fieldId, storageRoot), "artifacts");
  ensureDir(dir);
  return dir;
}

function atomicWrite(target: string, content: string): void {
  ensureDir(resolve(target, ".."));
  const temp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temp, content, { encoding: "utf-8", flag: "wx" });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        renameSync(temp, target);
        return;
      } catch (err: any) {
        if ((err?.code === "EPERM" || err?.code === "EBUSY") && attempt < 3) {
          Atomics.wait(lockWait, 0, 0, 10 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  } finally {
    if (existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch {
        /* best effort */
      }
    }
  }
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function withFileLock<T>(targetPath: string, fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  const lockPath = `${targetPath}.lock`;
  ensureDir(resolve(lockPath, ".."));
  const start = Date.now();
  const hostTag = currentHostTag();
  const selfStart = processStartIdentity(process.pid);

  while (true) {
    const token = randomUUID();
    const record: LockRecord = {
      version: 1,
      pid: process.pid,
      processStart: selfStart,
      hostTag,
      token,
      acquiredAt: Date.now(),
    };
    const candidate = `${lockPath}.cand.${process.pid}.${token}`;
    let acquired = false;
    try {
      writeFileSync(candidate, JSON.stringify(record), { encoding: "utf-8", flag: "wx", mode: 0o600 });
      try {
        linkSync(candidate, lockPath);
        acquired = true;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
      }
    } finally {
      if (existsSync(candidate)) {
        try {
          unlinkSync(candidate);
        } catch {
          /* consumed or cleaned */
        }
      }
    }

    if (acquired) {
      try {
        return fn();
      } finally {
        const current = readJsonSafe<LockRecord>(lockPath);
        if (current?.token === token) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* best effort */
          }
        }
      }
    }

    const held = readJsonSafe<LockRecord>(lockPath);
    if (held && ownerIsProvablyDead(held.pid, held.processStart, held.hostTag, held.acquiredAt)) {
      const check = readJsonSafe<LockRecord>(lockPath);
      if (check?.token === held.token) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* another waiter reclaimed it */
        }
      }
      continue;
    }

    if (Date.now() - start >= timeoutMs) {
      throw new Error(`Timed out waiting for field lock: ${lockPath}`);
    }
    Atomics.wait(lockWait, 0, 0, 15);
  }
}

// ---------------------------------------------------------------------------
// Field Lifecycle
// ---------------------------------------------------------------------------

export function openField(
  fieldId: string,
  goal: string,
  options: {
    topic?: string;
    createdBy?: string;
    mode?: FieldMode;
    rootCwd?: string;
    storageRoot?: string;
  } = {},
): FieldMeta {
  assertFieldId(fieldId);
  const trimmedGoal = String(goal ?? "").trim();
  if (!trimmedGoal) throw new Error("Field requires a non-empty goal");

  const dir = fieldDir(fieldId, options.storageRoot);
  ensureDir(dir);
  ensureDir(presenceDir(fieldId, options.storageRoot));
  ensureDir(resourcesDir(fieldId, options.storageRoot));
  ensureDir(artifactsDir(fieldId, options.storageRoot));

  const mPath = metaPath(fieldId, options.storageRoot);
  return withFileLock(mPath, () => {
    const existing = readJsonSafe<FieldMeta>(mPath);
    if (existing) return existing;
    const meta: FieldMeta = {
      version: 1,
      id: fieldId,
      goal: trimmedGoal,
      ...(options.topic ? { topic: options.topic } : {}),
      mode: options.mode === "worktree" ? "worktree" : "shared",
      status: "active",
      rootCwd: options.rootCwd ?? process.cwd(),
      ...(options.createdBy ? { createdBy: options.createdBy } : {}),
      createdAt: Date.now(),
    };
    atomicWrite(mPath, JSON.stringify(meta, null, 2) + "\n");
    return meta;
  });
}

export function getFieldMeta(fieldId: string, storageRoot?: string): FieldMeta | null {
  try {
    assertFieldId(fieldId);
  } catch {
    return null;
  }
  return readJsonSafe<FieldMeta>(metaPath(fieldId, storageRoot));
}

export function listFields(storageRoot?: string): FieldMeta[] {
  const dir = fieldsDir(storageRoot);
  if (!existsSync(dir)) return [];
  const results: FieldMeta[] = [];
  for (const entry of readdirSync(dir)) {
    const meta = readJsonSafe<FieldMeta>(join(dir, entry, "meta.json"));
    if (meta && meta.id === entry) results.push(meta);
  }
  return results.sort((a, b) => b.createdAt - a.createdAt);
}

export function closeField(
  fieldId: string,
  options: { status?: "closed" | "breached"; storageRoot?: string } = {},
): FieldMeta | null {
  assertFieldId(fieldId);
  const mPath = metaPath(fieldId, options.storageRoot);
  if (!existsSync(mPath)) return null;
  return withFileLock(mPath, () => {
    const current = readJsonSafe<FieldMeta>(mPath);
    if (!current) return null;
    const updated: FieldMeta = {
      ...current,
      status: options.status ?? "closed",
      closedAt: Date.now(),
    };
    atomicWrite(mPath, JSON.stringify(updated, null, 2) + "\n");
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Implicit Slime Trail / Live Presence (Lock-free per-actor file)
// ---------------------------------------------------------------------------

function mergeTargets(existing: string[], incoming: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const item of [...incoming, ...existing]) {
    const clean = String(item ?? "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    merged.push(clean);
    if (merged.length >= MAX_RECENT_TARGETS) break;
  }
  return merged;
}

export function updatePresence(
  fieldId: string,
  update: {
    actorId: string;
    label?: string;
    lens?: string;
    cwd?: string;
    heading?: string;
    focusArea?: string;
    targets?: string[];
    lastTool?: string;
    lastToolError?: boolean;
    incrementStep?: boolean;
    status?: "active" | "idle" | "done";
  },
  storageRoot?: string,
): ActorPresence {
  assertFieldId(fieldId);
  const dir = presenceDir(fieldId, storageRoot);
  ensureDir(dir);
  const file = join(dir, `${safeFileKey(update.actorId)}.json`);
  const prev = readJsonSafe<ActorPresence>(file);
  const focusArea = update.focusArea ?? prev?.focusArea;
  const next: ActorPresence = {
    actorId: update.actorId,
    label: update.label ?? prev?.label ?? update.actorId,
    ...(update.lens ?? prev?.lens ? { lens: update.lens ?? prev?.lens } : {}),
    pid: process.pid,
    processStart: processStartIdentity(process.pid),
    hostTag: currentHostTag(),
    cwd: update.cwd ?? prev?.cwd ?? process.cwd(),
    heading: oneLine(update.heading ?? prev?.heading ?? "exploring", 160),
    ...(focusArea ? { focusArea } : {}),
    recentTargets: mergeTargets(prev?.recentTargets ?? [], update.targets ?? []),
    stepCount: (prev?.stepCount ?? 0) + (update.incrementStep ? 1 : 0),
    ...(update.lastTool ?? prev?.lastTool ? { lastTool: update.lastTool ?? prev?.lastTool } : {}),
    ...(update.lastToolError !== undefined
      ? { lastToolError: update.lastToolError }
      : prev?.lastToolError !== undefined
        ? { lastToolError: prev.lastToolError }
        : {}),
    updatedAt: Date.now(),
    status: update.status ?? "active",
  };
  atomicWrite(file, JSON.stringify(next) + "\n");
  return next;
}

/** Lightweight mtime check so activity watchdogs know a tentacle is genuinely working. */
export function latestFieldActivityMs(
  fieldId: string,
  actorId?: string,
  storageRoot?: string,
): number {
  let latest = 0;
  const probe = (path: string) => {
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime > latest) latest = mtime;
    } catch {
      /* absent */
    }
  };
  try {
    assertFieldId(fieldId);
    if (actorId) {
      probe(join(presenceDir(fieldId, storageRoot), `${safeFileKey(actorId)}.json`));
    }
    probe(pulsesPath(fieldId, storageRoot));
  } catch {
    /* ignore */
  }
  return latest;
}

export function markPresenceDone(
  fieldId: string,
  actorId: string,
  status: "idle" | "done" = "done",
  storageRoot?: string,
): void {
  try {
    assertFieldId(fieldId);
    const file = join(presenceDir(fieldId, storageRoot), `${safeFileKey(actorId)}.json`);
    const prev = readJsonSafe<ActorPresence>(file);
    if (!prev) return;
    atomicWrite(file, JSON.stringify({ ...prev, status, updatedAt: Date.now() }) + "\n");
  } catch {
    /* shutdown cleanup must not throw */
  }
}

export function listPresences(
  fieldId: string,
  options: { includeInactive?: boolean; storageRoot?: string } = {},
): ActorPresence[] {
  assertFieldId(fieldId);
  const dir = presenceDir(fieldId, options.storageRoot);
  if (!existsSync(dir)) return [];
  const out: ActorPresence[] = [];
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const item = readJsonSafe<ActorPresence>(join(dir, name));
    if (!item || typeof item.actorId !== "string") continue;
    const dead = ownerIsProvablyDead(item.pid, item.processStart, item.hostTag, item.updatedAt);
    const stale = now - item.updatedAt > SAME_HOST_PRESENCE_STALE_MS;
    if (!options.includeInactive && (item.status !== "active" || dead || stale)) continue;
    out.push(dead && item.status === "active" ? { ...item, status: "done" } : item);
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Exclusive Resource Leases (Domain-Agnostic Mutual Exclusion Primitive)
// ---------------------------------------------------------------------------

export function normalizeResourceName(raw: string): string {
  const clean = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!clean) throw new Error("Resource name must be non-empty");
  return clean;
}

export function claimResource(
  fieldId: string,
  resource: string,
  holder: { actorId: string; label?: string; purpose: string },
  storageRoot?: string,
): ResourceClaimResult {
  assertFieldId(fieldId);
  const norm = normalizeResourceName(resource);
  const purpose = oneLine(holder.purpose || "exclusive access", 160);
  const dir = resourcesDir(fieldId, storageRoot);
  ensureDir(dir);
  const file = join(dir, `${safeFileKey(norm)}.json`);

  return withFileLock(file, () => {
    const existing = readJsonSafe<ResourceLease>(file);
    if (
      existing &&
      existing.holderId !== holder.actorId &&
      !ownerIsProvablyDead(existing.pid, existing.processStart, existing.hostTag, existing.updatedAt)
    ) {
      return { acquired: false, lease: existing };
    }
    const now = Date.now();
    const lease: ResourceLease = {
      resource: norm,
      holderId: holder.actorId,
      holderLabel: holder.label ?? holder.actorId,
      pid: process.pid,
      processStart: processStartIdentity(process.pid),
      hostTag: currentHostTag(),
      purpose,
      acquiredAt: existing?.holderId === holder.actorId ? existing.acquiredAt : now,
      updatedAt: now,
    };
    atomicWrite(file, JSON.stringify(lease) + "\n");
    return { acquired: true, lease };
  });
}

export function releaseResource(
  fieldId: string,
  resource: string,
  actorId: string,
  storageRoot?: string,
): boolean {
  assertFieldId(fieldId);
  const norm = normalizeResourceName(resource);
  const file = join(resourcesDir(fieldId, storageRoot), `${safeFileKey(norm)}.json`);
  if (!existsSync(file)) return false;
  return withFileLock(file, () => {
    const existing = readJsonSafe<ResourceLease>(file);
    if (!existing) return false;
    if (
      existing.holderId !== actorId &&
      !ownerIsProvablyDead(existing.pid, existing.processStart, existing.hostTag, existing.updatedAt)
    ) {
      return false;
    }
    try {
      unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  });
}

export function releaseAllResources(fieldId: string, actorId: string, storageRoot?: string): string[] {
  const released: string[] = [];
  try {
    assertFieldId(fieldId);
    const dir = resourcesDir(fieldId, storageRoot);
    if (!existsSync(dir)) return released;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const item = readJsonSafe<ResourceLease>(join(dir, name));
      if (item?.holderId === actorId) {
        if (releaseResource(fieldId, item.resource, actorId, storageRoot)) {
          released.push(item.resource);
        }
      }
    }
  } catch {
    /* best effort cleanup */
  }
  return released;
}

export function listResources(fieldId: string, storageRoot?: string): ResourceLease[] {
  assertFieldId(fieldId);
  const dir = resourcesDir(fieldId, storageRoot);
  if (!existsSync(dir)) return [];
  const active: ResourceLease[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const item = readJsonSafe<ResourceLease>(file);
    if (!item || typeof item.resource !== "string") continue;
    if (ownerIsProvablyDead(item.pid, item.processStart, item.hostTag, item.updatedAt)) {
      continue;
    }
    active.push(item);
  }
  return active.sort((a, b) => a.resource.localeCompare(b.resource));
}

// ---------------------------------------------------------------------------
// Explicit Objective Echo Pulses (Append-only JSONL, Zero Scoring)
// ---------------------------------------------------------------------------

export function readPulses(fieldId: string, sinceSeq?: number, storageRoot?: string): FieldPulse[] {
  assertFieldId(fieldId);
  const path = pulsesPath(fieldId, storageRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const pulses: FieldPulse[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as FieldPulse;
      if (Number.isInteger(parsed?.seq) && typeof parsed?.fact === "string") {
        pulses.push(parsed);
      }
    } catch {
      /* ignore torn trailing line if any */
    }
  }
  return sinceSeq === undefined ? pulses : pulses.filter((p) => p.seq > sinceSeq);
}

export function postPulse(fieldId: string, input: PostPulseInput, storageRoot?: string): FieldPulse {
  assertFieldId(fieldId);
  const fact = String(input.fact ?? "").trim();
  if (!fact) throw new Error("Pulse requires a non-empty objective fact");
  const kind: PulseKind = input.kind ?? "echo";
  if (!PULSE_KINDS.includes(kind)) {
    throw new Error(`Unknown pulse kind "${kind}" (expected: ${PULSE_KINDS.join(", ")})`);
  }

  const pPath = pulsesPath(fieldId, storageRoot);
  ensureDir(resolve(pPath, ".."));

  const pulse = withFileLock(pPath, () => {
    const existing = readPulses(fieldId, undefined, storageRoot);
    const seq = (existing.at(-1)?.seq ?? 0) + 1;
    const record: FieldPulse = {
      seq,
      timestamp: Date.now(),
      actorId: input.actorId,
      actorLabel: input.actorLabel ?? input.actorId,
      ...(input.lens ? { lens: input.lens } : {}),
      kind,
      fact,
      ...(input.anchor?.trim() ? { anchor: oneLine(input.anchor, 180) } : {}),
      ...(input.next?.trim() ? { next: oneLine(input.next, 180) } : {}),
    };
    appendFileSync(pPath, JSON.stringify(record) + "\n", "utf-8");
    return record;
  });

  if (kind === "breach") {
    const mPath = metaPath(fieldId, storageRoot);
    if (existsSync(mPath)) {
      withFileLock(mPath, () => {
        const meta = readJsonSafe<FieldMeta>(mPath);
        if (!meta) return;
        atomicWrite(
          mPath,
          JSON.stringify(
            {
              ...meta,
              status: "breached",
              breachedAt: pulse.timestamp,
              breachedBy: pulse.actorLabel,
              breachSeq: pulse.seq,
            },
            null,
            2,
          ) + "\n",
        );
      });
    }
  }

  // Keep presence aligned with the latest declared direction/anchor.
  try {
    updatePresence(
      fieldId,
      {
        actorId: input.actorId,
        label: input.actorLabel,
        lens: input.lens,
        heading: input.next || input.anchor || oneLine(fact, 120),
        targets: input.anchor ? [input.anchor] : [],
      },
      storageRoot,
    );
  } catch {
    /* pulse already persisted */
  }

  return pulse;
}

export function listArtifacts(fieldId: string, storageRoot?: string): string[] {
  assertFieldId(fieldId);
  const dir = join(fieldDir(fieldId, storageRoot), "artifacts");
  if (!existsSync(dir)) return [];
  const entries: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    try {
      const info = statSync(join(dir, name));
      entries.push(info.isDirectory() ? `${name}/` : `${name} (${info.size}B)`);
    } catch {
      entries.push(name);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Automatic Slime-Trail Extraction (Zero LLM Token Cost)
// ---------------------------------------------------------------------------

function normalizePathTarget(rawPath: string, rootCwd: string): string {
  const clean = rawPath.trim();
  if (!clean) return "";
  try {
    const abs = resolve(rootCwd, clean);
    const rel = relative(resolve(rootCwd), abs);
    if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
      return rel.replace(/\\/g, "/");
    }
  } catch {
    /* keep raw */
  }
  return clean.length > 96 ? `…/${basename(clean)}` : clean;
}

function dirOfTarget(target: string): string | undefined {
  const clean = target.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean || clean === ".") return undefined;
  const parent = dirname(clean);
  if (parent && parent !== "." && parent !== "/") return parent;
  return undefined;
}

function focusAreaFromTarget(target: string): string | undefined {
  const clean = target.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean || clean === ".") return undefined;
  return dirOfTarget(clean) ?? clean;
}

/**
 * Domain-agnostic implicit trail extraction: inspects generic argument shapes
 * (path / command / query) without hardcoding specific external tools.
 */
export function extractToolTrace(
  toolName: string,
  input: Record<string, unknown> = {},
  rootCwd = process.cwd(),
): ToolTraceSummary {
  const tool = String(toolName ?? "").toLowerCase();
  const rawPath = String(input.file_path ?? input.path ?? "").trim();
  const normalizedPath = rawPath ? normalizePathTarget(rawPath, rootCwd) : "";

  if (tool === "field") {
    const action = String(input.action ?? "pulse");
    const detail = oneLine(String(input.anchor ?? input.resource ?? input.fact ?? ""), 64);
    return {
      heading: detail ? `field:${action} ${detail}` : `field:${action}`,
      targets: [],
    };
  }

  if (normalizedPath) {
    const query = oneLine(String(input.pattern ?? input.query ?? ""), 40);
    const heading = query ? `${tool} "${query}" in ${normalizedPath}` : `${tool} ${normalizedPath}`;
    return {
      heading,
      targets: [normalizedPath],
      focusArea: focusAreaFromTarget(normalizedPath),
    };
  }

  const command = oneLine(String(input.command ?? ""), 88);
  if (command) {
    // Derive a coarse focus bucket if the command references a relative directory path.
    const dirHit = /(?:^|\s)([a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+)/.exec(command);
    const dirTarget = dirHit ? normalizePathTarget(dirHit[1], rootCwd) : "";
    const focusArea = dirTarget ? focusAreaFromTarget(dirTarget) : undefined;
    return {
      heading: `${tool}: ${command}`,
      targets: dirTarget ? [dirTarget] : [],
      ...(focusArea ? { focusArea } : {}),
    };
  }

  const query = oneLine(String(input.pattern ?? input.query ?? ""), 64);
  if (query) {
    return {
      heading: `${tool} "${query}"`,
      targets: [],
      focusArea: `q:${query.slice(0, 24)}`,
    };
  }

  return { heading: tool, targets: [] };
}

// ---------------------------------------------------------------------------
// High-Density Sideline Delta & Snapshot Rendering
// ---------------------------------------------------------------------------

export function emptySidelineCursor(): SidelineCursor {
  return {
    lastPulseSeq: 0,
    lastResourcesSig: "",
    lastPeersSig: "",
    lastOverlapSig: "",
    seenBreachSeqs: [],
  };
}

function formatAgeSec(ts: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${sec % 60}s`;
}

export function formatPulseLine(pulse: FieldPulse, options: { full?: boolean } = {}): string {
  const lensTag = pulse.lens ? `/${pulse.lens}` : "";
  const anchor = pulse.anchor ? ` (${pulse.anchor})` : "";
  const fact = options.full
    ? String(pulse.fact ?? "").replace(/\s+/g, " ").trim()
    : oneLine(pulse.fact, 360);
  const next = pulse.next
    ? ` -> next: ${options.full ? String(pulse.next).replace(/\s+/g, " ").trim() : oneLine(pulse.next, 180)}`
    : "";
  const kindTag = pulse.kind === "breach" ? "BREACH!" : pulse.kind;
  return `#${pulse.seq} [${pulse.actorLabel}${lensTag}|${kindTag}]${anchor} ${fact}${next}`;
}

export function buildSidelineDelta(
  fieldId: string,
  selfActorId: string,
  cursor: SidelineCursor,
  options: {
    currentTargets?: string[];
    storageRoot?: string;
    now?: number;
  } = {},
): SidelineDelta | null {
  assertFieldId(fieldId);
  const now = options.now ?? Date.now();
  const allPulses = readPulses(fieldId, undefined, options.storageRoot);
  const latestSeq = allPulses.at(-1)?.seq ?? cursor.lastPulseSeq;
  const newPulses = allPulses.filter(
    (p) => p.seq > cursor.lastPulseSeq && p.actorId !== selfActorId,
  );
  const unseenBreaches = allPulses.filter(
    (p) =>
      p.kind === "breach" &&
      p.actorId !== selfActorId &&
      !cursor.seenBreachSeqs.includes(p.seq),
  );
  const livePeers = listPresences(fieldId, { storageRoot: options.storageRoot }).filter(
    (p) => p.actorId !== selfActorId,
  );
  const resources = listResources(fieldId, options.storageRoot);

  // Detect spatial overlap on exact targets or localized subdirectories (depth >= 2,
  // avoiding noisy overlap alarms across a flat top-level folder like "src").
  const currentTargetSet = new Set(
    (options.currentTargets ?? []).filter((t) => t && t !== "."),
  );
  const currentSubdirSet = new Set(
    [...currentTargetSet]
      .map((t) => dirOfTarget(t))
      .filter((d): d is string => Boolean(d && d.includes("/"))),
  );
  const overlaps: OverlapHit[] = [];
  if (currentTargetSet.size > 0) {
    for (const peer of livePeers) {
      let matchedTarget: string | undefined;
      for (const target of peer.recentTargets) {
        if (currentTargetSet.has(target)) {
          matchedTarget = target;
          break;
        }
      }
      if (!matchedTarget && currentSubdirSet.size > 0) {
        const peerArea = (peer.focusArea ?? dirOfTarget(peer.recentTargets[0] ?? ""))?.replace(/\/+$/, "");
        if (peerArea && currentSubdirSet.has(peerArea)) {
          matchedTarget = peerArea;
        }
      }
      if (matchedTarget) {
        overlaps.push({
          peerId: peer.actorId,
          peerLabel: peer.label,
          peerLens: peer.lens,
          target: matchedTarget,
          ageSec: Math.max(0, Math.round((now - peer.updatedAt) / 1000)),
        });
      }
    }
  }

  const resourcesSig = resources
    .map((r) => `${r.resource}=${r.holderId}:${r.purpose}`)
    .join("|");
  // Coarse peer signature: fires whenever peer membership changes OR a peer
  // shifts into a different coarse focus area (avoids deafening peers after the
  // first turn while remaining quiet during repeated work inside the same area).
  const peersSig = livePeers
    .map((p) => `${p.actorId}:${(p.focusArea ?? focusAreaFromTarget(p.recentTargets[0] ?? "") ?? "").replace(/\/+$/, "")}`)
    .join("|");
  const overlapSig = overlaps
    .map((o) => `${o.peerId}@${o.target}`)
    .sort()
    .join("|");

  const hasNewPulses = newPulses.length > 0;
  const hasBreach = unseenBreaches.length > 0;
  const resourcesChanged = resourcesSig !== cursor.lastResourcesSig;
  const overlapAppeared = overlapSig.length > 0 && overlapSig !== cursor.lastOverlapSig;
  const peersShifted = peersSig !== cursor.lastPeersSig && (livePeers.length > 0 || cursor.lastPeersSig !== "");

  if (!hasNewPulses && !hasBreach && !resourcesChanged && !overlapAppeared && !peersShifted) {
    return null;
  }

  const lines: string[] = [];
  const range =
    newPulses.length > 0
      ? ` #${newPulses[0].seq}..#${newPulses.at(-1)!.seq}`
      : "";
  lines.push(`[FIELD Δ${range} | field=${fieldId}]`);

  if (hasBreach) {
    lines.push("BREACH WAVE — a peer verified a breakthrough (evaluate against the full goal):");
    for (const bp of unseenBreaches) {
      lines.push(`  >> ${formatPulseLine(bp)}`);
    }
  }

  if (livePeers.length > 0) {
    const summary = livePeers
      .map((p) => {
        const lens = p.lens ? `(${p.lens})` : "";
        return `${p.label}${lens}: ${oneLine(p.heading, 64)} [${formatAgeSec(p.updatedAt, now)}]`;
      })
      .join(" | ");
    lines.push(`LIVE: ${summary}`);
  }

  if (resources.length > 0) {
    const locks = resources
      .map((r) => `${r.resource} -> ${r.holderLabel} (${oneLine(r.purpose, 48)})`)
      .join(" | ");
    lines.push(`LOCK: ${locks}`);
  }

  if (overlaps.length > 0) {
    for (const o of overlaps) {
      const lens = o.peerLens ? ` (${o.peerLens})` : "";
      lines.push(
        `OVERLAP: ${o.peerLabel}${lens} also touched ${o.target} (${o.ageSec}s ago) — use an orthogonal angle if high-traction, or pivot to fresh surface.`,
      );
    }
  }

  const nonBreachNew = newPulses.filter((p) => !unseenBreaches.some((b) => b.seq === p.seq));
  for (const p of nonBreachNew) {
    lines.push(formatPulseLine(p));
  }

  const nextCursor: SidelineCursor = {
    lastPulseSeq: latestSeq,
    lastResourcesSig: resourcesSig,
    lastPeersSig: peersSig,
    lastOverlapSig: overlapSig,
    seenBreachSeqs: [
      ...new Set([...cursor.seenBreachSeqs, ...unseenBreaches.map((b) => b.seq)]),
    ],
  };

  return {
    text: lines.join("\n"),
    nextCursor,
    newPulses,
    hasBreach,
    breachPulses: unseenBreaches,
    livePeers,
    resources,
    overlaps,
  };
}

export function buildFieldSnapshot(
  fieldId: string,
  options: {
    selfActorId?: string;
    maxRecentPulses?: number;
    storageRoot?: string;
  } = {},
): string {
  const meta = getFieldMeta(fieldId, options.storageRoot);
  if (!meta) return `[FIELD ${fieldId}: not found]`;
  const now = Date.now();
  const presences = listPresences(fieldId, { storageRoot: options.storageRoot });
  const resources = listResources(fieldId, options.storageRoot);
  const pulses = readPulses(fieldId, undefined, options.storageRoot);
  const artifacts = listArtifacts(fieldId, options.storageRoot);
  const maxPulses = options.maxRecentPulses ?? 20;
  const shown = pulses.slice(-maxPulses);
  const omitted = pulses.length - shown.length;

  const lines: string[] = [
    `[FIELD SNAPSHOT | id=${meta.id} | status=${meta.status} | mode=${meta.mode}]`,
    `GOAL: ${meta.goal}`,
    `ARTIFACTS DIR: ${artifactsDir(fieldId, options.storageRoot)}`,
  ];

  if (presences.length > 0) {
    lines.push(
      `LIVE (${presences.length}): ` +
        presences
          .map((p) => {
            const self = p.actorId === options.selfActorId ? "*" : "";
            const lens = p.lens ? `(${p.lens})` : "";
            return `${self}${p.label}${lens}: ${oneLine(p.heading, 64)} [${formatAgeSec(p.updatedAt, now)}]`;
          })
          .join(" | "),
    );
  } else {
    lines.push("LIVE: none");
  }

  if (resources.length > 0) {
    lines.push(
      "LOCKS: " +
        resources
          .map((r) => `${r.resource} -> ${r.holderLabel} (${r.purpose})`)
          .join(" | "),
    );
  }

  if (artifacts.length > 0) {
    lines.push(`ARTIFACTS: ${artifacts.join(", ")}`);
  }

  if (shown.length > 0) {
    lines.push(
      `PULSES (${omitted > 0 ? `latest ${shown.length} of ${pulses.length}` : pulses.length}):`,
    );
    for (const p of shown) lines.push(`  ${formatPulseLine(p)}`);
  } else {
    lines.push("PULSES: none yet");
  }

  return lines.join("\n");
}

export interface TentacleOutcome {
  label: string;
  lens?: string;
  model?: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  worktreePath?: string;
  worktreeDiffStat?: string;
}

/**
 * Single-point structured digest of a completed Live Flux run for posting
 * ONE clean record to the main Board topic. Groups objective pulses by kind
 * instead of concatenating N redundant synthesis essays.
 */
export function buildCollectiveBoardSummary(
  fieldId: string,
  outcomes: TentacleOutcome[],
  storageRoot?: string,
): string {
  const meta = getFieldMeta(fieldId, storageRoot);
  const pulses = readPulses(fieldId, undefined, storageRoot);
  const artifacts = listArtifacts(fieldId, storageRoot);

  const byKind = (kind: PulseKind) => pulses.filter((p) => p.kind === kind);
  const breaches = byKind("breach");
  const conflicts = byKind("conflict");
  const artifactPulses = byKind("artifact");
  const echoes = byKind("echo");
  const needs = byKind("need");

  const statusDisplay = meta?.breachSeq
    ? `breached (#${meta.breachSeq} by ${meta.breachedBy ?? "peer"})`
    : (meta?.status ?? "closed");
  const lines: string[] = [
    `## Live Flux Field: ${fieldId}`,
    `- **Goal**: ${meta?.goal ?? "(unknown)"}`,
    `- **Mode**: ${meta?.mode ?? "shared"} | **Status**: ${statusDisplay} | **Tentacles**: ${outcomes.length} | **Pulses**: ${pulses.length}`,
  ];

  if (breaches.length > 0) {
    lines.push("", "### Breakthroughs (Verified Environment Hits)");
    for (const p of breaches) lines.push(`- ${formatPulseLine(p, { full: true })}`);
  }

  if (conflicts.length > 0) {
    lines.push("", "### Factual Conflicts (High-Gain Tension)");
    for (const p of conflicts) lines.push(`- ${formatPulseLine(p, { full: true })}`);
  }

  if (artifactPulses.length > 0 || artifacts.length > 0) {
    lines.push("", `### Shared Artifacts (\`${artifactsDir(fieldId, storageRoot)}\`)`);
    for (const p of artifactPulses) lines.push(`- ${formatPulseLine(p, { full: true })}`);
    if (artifacts.length > 0) lines.push(`- Files on disk: ${artifacts.join(", ")}`);
  }

  if (echoes.length > 0) {
    lines.push("", "### Objective Echoes (Lens × Observation)");
    for (const p of echoes) lines.push(`- ${formatPulseLine(p, { full: true })}`);
  }

  if (needs.length > 0) {
    lines.push("", "### Open Needs / Follow-up Probes");
    for (const p of needs) lines.push(`- ${formatPulseLine(p, { full: true })}`);
  }

  lines.push("", "### Tentacle Summaries");
  for (const o of outcomes) {
    const status = o.timedOut ? "TIMED OUT" : `exit ${o.exitCode}`;
    const metaTag = [o.lens, o.model].filter(Boolean).join(", ");
    const wt = o.worktreeDiffStat
      ? `\n  - Worktree changes (${o.worktreePath}): ${oneLine(o.worktreeDiffStat, 240)}`
      : "";
    const excerpt = o.output.trim() || "(no final stdout)";
    lines.push(`- **${o.label}** [${metaTag || "default"}] (${status})${wt}\n${excerpt}`);
  }

  return lines.join("\n");
}
