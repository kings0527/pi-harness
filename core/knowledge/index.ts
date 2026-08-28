import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { appendEvent } from "../events/index.ts";

// Lifecycle of an index row. `active` is the implicit default so every legacy
// row (no tag) keeps its current meaning. Retired rows stay in the file for
// traceability but fold out of the model's primary catalog (ADR-0026).
export type IndexEntryStatus = "active" | "superseded" | "archived" | "deprecated";

const RETIRED_STATUS_BY_TAG: Record<string, IndexEntryStatus> = {
  SUPERSEDED: "superseded",
  ARCHIVED: "archived",
  DEPRECATED: "deprecated",
};

// A leading, case-insensitive `[TAG]` marks a row's lifecycle. It is stripped
// before the path is parsed so a retired row never resolves as a dead link.
const STATUS_TAG_PATTERN = /^\[(SUPERSEDED|ARCHIVED|DEPRECATED)\]\s*/i;

export interface IndexEntry {
  path: string;
  description: string;
  status: IndexEntryStatus;
}

export interface KnowledgeIndexIssue {
  path: string;
  reason: "missing" | "invalid";
  detail?: string;
}

// ADR-0014: fixed local-project, shared-workspace, and cross-workspace tiers.
export type KnowledgeScope = "project" | "workspace" | "global";

function assertScope(scope: KnowledgeScope): void {
  if (scope !== "project" && scope !== "workspace" && scope !== "global") {
    throw new Error(`Invalid knowledge scope "${String(scope)}"`);
  }
}

/** The project boundary is the pi session root; never promote it to a Git ancestor. */
export function getProjectRoot(startDir: string = process.cwd()): string {
  return resolve(startDir);
}

/** Resolve the containing Git workspace; non-Git sessions share their project root. */
export function getWorkspaceRoot(startDir: string = process.cwd()): string {
  const projectRoot = getProjectRoot(startDir);
  let current = projectRoot;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return projectRoot;
    current = parent;
  }
}

export function getKnowledgeRoot(scope: KnowledgeScope = "project"): string {
  assertScope(scope);
  if (scope === "global") return join(homedir(), ".pi-harness", "knowledge");
  if (scope === "workspace") return join(getWorkspaceRoot(), "knowledge");
  return join(getProjectRoot(), "knowledge");
}

function getIndexPath(scope: KnowledgeScope): string {
  return join(getKnowledgeRoot(scope), "index.md");
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertNoSymlinkComponents(root: string, fullPath: string): void {
  const rel = relative(root, fullPath);
  let current = root;
  if (isSymlink(current)) {
    throw new Error(`Knowledge root must not be a symlink: "${root}"`);
  }

  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (isSymlink(current)) {
      throw new Error(`Knowledge path must not traverse a symlink: "${current}"`);
    }
  }
}

function resolveEntryPath(entryPath: string, scope: KnowledgeScope): string {
  if (typeof entryPath !== "string" || entryPath.trim() === "") {
    throw new Error("Knowledge entry path is required");
  }
  if (entryPath.includes("\0") || /[\r\n|]/.test(entryPath)) {
    throw new Error(`Invalid knowledge entry path "${entryPath}"`);
  }
  if (isAbsolute(entryPath)) {
    throw new Error(`Knowledge entry path must be relative: "${entryPath}"`);
  }

  const root = getKnowledgeRoot(scope);
  const fullPath = resolve(root, entryPath);
  const rel = relative(root, fullPath);
  const outsideRoot = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!rel || outsideRoot) {
    throw new Error(`Knowledge entry path escapes the ${scope} root: "${entryPath}"`);
  }
  if (rel === "index.md") {
    throw new Error('"index.md" is reserved for the knowledge index');
  }

  assertNoSymlinkComponents(root, fullPath);
  return fullPath;
}

function assertSingleLine(value: string, field: string): void {
  if (!value || value.trim() === "" || /[\r\n]/.test(value)) {
    throw new Error(`${field} must be a non-empty single line`);
  }
}

function atomicWrite(path: string, content: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx" });
    renameSync(tmpPath, path);
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}

function recordKnowledgeEvent(details: Record<string, unknown>): void {
  try {
    appendEvent("distill", details);
  } catch {
    // The knowledge files and index are authoritative; event logging is secondary.
  }
}

/** Parse the selected knowledge index without creating directories. */
export function getIndex(scope: KnowledgeScope = "project"): IndexEntry[] {
  const indexPath = getIndexPath(scope);
  assertNoSymlinkComponents(getKnowledgeRoot(scope), indexPath);
  if (!existsSync(indexPath)) return [];

  const content = readFileSync(indexPath, "utf-8");
  const entries: IndexEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--")) continue;

    const tag = STATUS_TAG_PATTERN.exec(trimmed);
    const status = tag ? RETIRED_STATUS_BY_TAG[tag[1].toUpperCase()] : "active";
    const row = tag ? trimmed.slice(tag[0].length) : trimmed;

    const pipeIndex = row.indexOf("|");
    if (pipeIndex === -1) continue;

    const path = row.slice(0, pipeIndex).trim();
    const description = row.slice(pipeIndex + 1).trim();
    if (path && description) entries.push({ path, description, status });
  }

  return entries;
}

/** Find stale or invalid index rows without reading entry contents or mutating disk. */
export function auditIndex(scope: KnowledgeScope = "project"): KnowledgeIndexIssue[] {
  return getIndex(scope).flatMap<KnowledgeIndexIssue>(entry => {
    try {
      const fullPath = resolveEntryPath(entry.path, scope);
      return existsSync(fullPath) ? [] : [{ path: entry.path, reason: "missing" }];
    } catch (error: any) {
      return [{ path: entry.path, reason: "invalid", detail: error?.message }];
    }
  });
}

/** Read an entry without creating directories. */
export function getEntry(entryPath: string, scope: KnowledgeScope = "project"): string | null {
  const fullPath = resolveEntryPath(entryPath, scope);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, "utf-8");
}

/** Add a sourced entry and update the selected index. */
export function addEntry(
  entryPath: string,
  content: string,
  sourceLink: string,
  description: string,
  scope: KnowledgeScope = "project"
): void {
  assertSingleLine(sourceLink, "Source link");
  assertSingleLine(description, "Description");

  const fullPath = resolveEntryPath(entryPath, scope);
  if (existsSync(fullPath)) {
    throw new Error(
      `Entry "${entryPath}" already exists. Use markConflict() if the new finding contradicts it, or choose a different path.`
    );
  }

  const dir = dirname(fullPath);
  mkdirSync(dir, { recursive: true });
  assertNoSymlinkComponents(getKnowledgeRoot(scope), fullPath);

  const entryContent = `${content.trim()}\n\n---\n\n来源: ${sourceLink}\n`;
  writeFileSync(fullPath, entryContent, { encoding: "utf-8", flag: "wx" });

  try {
    updateIndex(entryPath, description, scope);
  } catch (error) {
    if (existsSync(fullPath)) unlinkSync(fullPath);
    throw error;
  }

  recordKnowledgeEvent({
    action: "add_entry",
    path: entryPath,
    source: sourceLink,
    scope,
  });
}

/** Append an explicit conflict block while preserving the original entry. */
export function markConflict(
  existingPath: string,
  newSourceLink: string,
  conflictDescription: string,
  scope: KnowledgeScope = "project"
): void {
  assertSingleLine(newSourceLink, "Source link");
  if (!conflictDescription || conflictDescription.trim() === "") {
    throw new Error("Conflict description is required");
  }

  const fullPath = resolveEntryPath(existingPath, scope);
  if (!existsSync(fullPath)) {
    throw new Error(`Entry "${existingPath}" not found — cannot mark conflict`);
  }

  const currentContent = readFileSync(fullPath, "utf-8");
  const conflictBlock = `\n\n## ⚠️ CONFLICT (${new Date().toISOString()})\n\n` +
    `**New evidence contradicts this entry.**\n\n` +
    `${conflictDescription}\n\n` +
    `来源: ${newSourceLink}\n`;

  atomicWrite(fullPath, currentContent + conflictBlock);

  recordKnowledgeEvent({
    action: "mark_conflict",
    path: existingPath,
    newSource: newSourceLink,
    scope,
  });
}

function updateIndex(entryPath: string, description: string, scope: KnowledgeScope): void {
  const indexPath = getIndexPath(scope);
  const root = getKnowledgeRoot(scope);
  assertNoSymlinkComponents(root, indexPath);
  mkdirSync(root, { recursive: true });
  assertNoSymlinkComponents(root, indexPath);

  const content = existsSync(indexPath) ? readFileSync(indexPath, "utf-8") : "";
  const lines = content.split("\n");
  let found = false;

  const updated = lines.map(line => {
    const pipeIndex = line.indexOf("|");
    if (pipeIndex === -1) return line;
    const rawPath = line.slice(0, pipeIndex).trim();
    const tag = STATUS_TAG_PATTERN.exec(rawPath);
    const indexedPath = tag ? rawPath.slice(tag[0].length).trim() : rawPath;
    if (indexedPath !== entryPath) return line;
    found = true;
    // Re-distilling a path with fresh evidence reactivates it: drop any prior
    // retirement tag so the row rejoins the primary catalog.
    return `${entryPath} | ${description}`;
  });

  const nextContent = found
    ? updated.join("\n")
    : `${content.trimEnd()}${content.trimEnd() ? "\n" : ""}${entryPath} | ${description}\n`;
  atomicWrite(indexPath, nextContent);
}
