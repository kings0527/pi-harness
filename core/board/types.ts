export type WitnessKind = "v1" | "legacy-structured" | "unverified";

/** Runtime-derived identity. `label` is presentation-only, never authority. */
export interface BoardActor {
  id: string;
  label?: string;
  /** Session-file lineage for fork/clone audit; it is not an authorization grant. */
  parentSession?: string;
}

export type NoteKind =
  | "declare"
  | "plan"
  | "claim"
  | "evidence"
  | "challenge"
  | "verification"
  | "decision"
  | "retraction"
  | "convergence";

export interface NoteRef {
  topic: string;
  seq: number;
}

export type RelationKind = "supports" | "depends-on" | "conflicts-with" | "duplicate-of" | "child-of";

export interface TopicRelation {
  type: RelationKind;
  topic: string;
}

export interface Topic {
  id: string;
  goal: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
  /** Present only for newly-created structured topics; legacy topics remain valid. */
  createdBy?: BoardActor;
  /** Runtime-derived closer for structured topics. */
  closedBy?: BoardActor;
  /** Initial declared relations. Later relations are append-only declaration notes. */
  relations?: TopicRelation[];
  /**
   * ADR-0020: set to 1 when a topic is closed by the integrity-aware writer.
   * Marks the archive as "v1" — its summary MUST carry the first-line witness
   * and finalSeq/witness/JSONL maxSeq must all agree. Archives without this
   * field are legacy and fall back to structured header parsing.
   */
  integrityVersion?: 1;
  /** Note count at close; the machine-witness counterpart inside the META. */
  finalSeq?: number;
}

export interface Note {
  seq: number;
  author: string;
  timestamp: number;
  tags?: string[];
  priority?: "critical";
  content: string;
  /** Runtime-derived for Board-tool writes; absent on legacy/direct core writes. */
  actor?: BoardActor;
  /** Omitted means legacy/free-form note, retained for backward compatibility. */
  kind?: NoteKind;
  /** Structured causal/audit links; never inferred from prose. */
  targets?: NoteRef[];
  relations?: TopicRelation[];
  /** Only explicit material claims participate in the stricter close gate. */
  material?: boolean;
  /** Required by structured convergence notes. */
  verdict?: string;
  /** Explicitly accepted bounded unknowns at convergence. */
  unresolved?: NoteRef[];
}

export interface TopicMeta {
  id: string;
  goal: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
  noteCount: number;
  createdBy?: BoardActor;
  relations?: TopicRelation[];
  /** Archive cross-check state: v1 / legacy-structured / unverified. */
  integrity?: "v1" | "legacy-structured" | "unverified";
}

/** Metadata-only row: safe to inject before a session explicitly joins a topic. */
export interface TopicCatalogEntry extends TopicMeta {
  lastActivityAt: number;
  lastSeq: number;
  criticalCount: number;
  lastCriticalSeq?: number;
  participants: string[];
  relations: TopicRelation[];
}

export interface CloseReadiness {
  ready: boolean;
  reason?: string;
  convergence?: Note;
  openMaterialClaims: NoteRef[];
  openChallenges: NoteRef[];
}
