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

export {
  artifactsDir,
  buildCollectiveBoardSummary,
  buildFieldSnapshot,
  buildSidelineDelta,
  claimResource,
  closeField,
  emptySidelineCursor,
  extractToolTrace,
  getFieldMeta,
  latestFieldActivityMs,
  listArtifacts,
  listFields,
  listPresences,
  listResources,
  markPresenceDone,
  openField,
  postPulse,
  PULSE_KINDS,
  readPulses,
  releaseAllResources,
  releaseResource,
  resolveFieldStorageRoot,
  updatePresence,
} from "./field/index.ts";
export type {
  ActorPresence,
  FieldMeta,
  FieldMode,
  FieldPulse,
  FieldStatus,
  OverlapHit,
  PostPulseInput,
  PulseKind,
  ResourceClaimResult,
  ResourceLease,
  SidelineCursor,
  SidelineDelta,
  TentacleOutcome,
  ToolTraceSummary,
} from "./field/index.ts";

export {
  createTentacleWorktree,
  inspectWorktreeChanges,
  isGitRepository,
  removeTentacleWorktree,
} from "./field/worktree.ts";
export type { TentacleWorktree } from "./field/worktree.ts";

export {
  clearProjectFluxConfig,
  COGNITIVE_LENSES,
  getFluxConfig,
  getGlobalFluxPath,
  getProjectFluxPath,
  hasProjectFluxConfig,
  isFluxDisabled,
  pickStartingLenses,
  resolveFluxModels,
  resolveLens,
  setFluxConfig,
} from "./flux/index.ts";
export type {
  CognitiveLens,
  FluxConfig,
  FluxConfigOptions,
  FluxConfigScope,
  LensId,
  ResolvedLens,
} from "./flux/index.ts";

export { FLUX_DISCIPLINE } from "./identity/index.ts";

