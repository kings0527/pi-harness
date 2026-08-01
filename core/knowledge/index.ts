import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { appendEvent } from "../events/index.ts";

export interface IndexEntry {
  path: string;
  description: string;
}

// Knowledge root is relative to package root
function getKnowledgeRoot(): string {
  // Package root: parent of core/
  const root = join(import.meta.dirname || __dirname, "..", "..", "knowledge");
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  return root;
}

function getIndexPath(): string {
  return join(getKnowledgeRoot(), "index.md");
}

/**
 * Parse knowledge/index.md and return entries
 * Format: each line is "path | description" (ignoring comments and headers)
 */
export function getIndex(): IndexEntry[] {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) return [];

  const content = readFileSync(indexPath, "utf-8");
  const entries: IndexEntry[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip empty lines, headers, and comments
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--")) continue;

    // Parse "path | description" format
    const pipeIndex = trimmed.indexOf("|");
    if (pipeIndex === -1) continue;

    const path = trimmed.slice(0, pipeIndex).trim();
    const description = trimmed.slice(pipeIndex + 1).trim();

    if (path && description) {
      entries.push({ path, description });
    }
  }

  return entries;
}

/**
 * Read a specific knowledge entry file
 */
export function getEntry(entryPath: string): string | null {
  const fullPath = join(getKnowledgeRoot(), entryPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, "utf-8");
}

/**
 * Add a new knowledge entry with mandatory source link
 * @param entryPath - relative path within knowledge/ (e.g., "reverse-engineering/ghidra/known-limitations.md")
 * @param content - markdown content
 * @param sourceLink - traceability link (e.g., "topic-investigation#seq-12")
 * @param description - one-line description for index.md
 */
export function addEntry(
  entryPath: string,
  content: string,
  sourceLink: string,
  description: string
): void {
  // Validate: source link is mandatory
  if (!sourceLink || sourceLink.trim() === "") {
    throw new Error("Source link is required (溯源). Unsourced entries are rejected.");
  }

  // Check for conflicts with existing entries
  const existing = getEntry(entryPath);
  if (existing) {
    throw new Error(
      `Entry "${entryPath}" already exists. Use markConflict() if the new finding contradicts it, or choose a different path.`
    );
  }

  // Ensure directory exists
  const fullPath = join(getKnowledgeRoot(), entryPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write entry with source attribution
  const entryContent = `${content.trim()}\n\n---\n\n来源: ${sourceLink}\n`;
  writeFileSync(fullPath, entryContent, "utf-8");

  // Update index.md
  updateIndex(entryPath, description);

  // Log event
  appendEvent("distill", {
    action: "add_entry",
    path: entryPath,
    source: sourceLink,
  });
}

/**
 * Mark an existing entry as conflicting with new evidence
 * NEVER silently overwrite — always mark CONFLICT explicitly
 */
export function markConflict(
  existingPath: string,
  newSourceLink: string,
  conflictDescription: string
): void {
  const fullPath = join(getKnowledgeRoot(), existingPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Entry "${existingPath}" not found — cannot mark conflict`);
  }

  const currentContent = readFileSync(fullPath, "utf-8");

  // Append CONFLICT block (never modify original content)
  const conflictBlock = `\n\n## ⚠️ CONFLICT (${new Date().toISOString()})\n\n` +
    `**New evidence contradicts this entry.**\n\n` +
    `${conflictDescription}\n\n` +
    `来源: ${newSourceLink}\n`;

  writeFileSync(fullPath, currentContent + conflictBlock, "utf-8");

  // Log event
  appendEvent("distill", {
    action: "mark_conflict",
    path: existingPath,
    newSource: newSourceLink,
  });
}

/**
 * Update index.md with a new or modified entry
 */
function updateIndex(entryPath: string, description: string): void {
  const indexPath = getIndexPath();
  let content = "";

  if (existsSync(indexPath)) {
    content = readFileSync(indexPath, "utf-8");
  }

  // Check if entry already in index
  if (content.includes(entryPath)) {
    // Update existing line
    const lines = content.split("\n");
    const updated = lines.map(line => {
      if (line.trim().startsWith(entryPath)) {
        return `${entryPath} | ${description}`;
      }
      return line;
    });
    writeFileSync(indexPath, updated.join("\n"), "utf-8");
  } else {
    // Append new line before any trailing whitespace
    const trimmed = content.trimEnd();
    const newContent = trimmed + `\n${entryPath} | ${description}\n`;
    writeFileSync(indexPath, newContent, "utf-8");
  }
}
