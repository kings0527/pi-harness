/**
 * Single entry point for host runtimes that embed this core (ADR-0001).
 *
 * Bundling one entry matters: a host process serves several projects at once,
 * so every consumer must share one `AsyncLocalStorage` instance. Two separate
 * bundles would each get their own scope module and quietly stop seeing each
 * other's root.
 *
 * pi itself does not use this file; it imports the individual modules directly.
 */
export { runWithProjectRoot, scopedProjectRoot } from "./runtime/root.ts";

export {
  assessCloseReadiness,
  closeTopic,
  getTopicCatalogEntry,
  hasArchivedTopic,
  listOpenTopicCatalog,
  listOpenTopics,
  listTopicCatalog,
  listTopics,
  openTopic,
  postNote,
  readArchivedTopic,
  readNotes,
} from "./board/index.ts";
export type { BoardActor, Note, NoteKind, NoteRef, Topic, TopicRelation } from "./board/types.ts";

export {
  addEntry,
  auditIndex,
  getEntry,
  getIndex,
  getKnowledgeRoot,
  getProjectRoot,
  getWorkspaceRoot,
  markConflict,
} from "./knowledge/index.ts";
export type { IndexEntry, KnowledgeIndexIssue, KnowledgeScope } from "./knowledge/index.ts";

export { appendEvent } from "./events/index.ts";
