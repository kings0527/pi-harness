export type WitnessKind = "v1" | "legacy-structured" | "unverified";

export interface Topic {
  id: string;
  goal: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
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
}

export interface TopicMeta {
  id: string;
  goal: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
  noteCount: number;
  /** Archive cross-check state: v1 / legacy-structured / unverified. */
  integrity?: "v1" | "legacy-structured" | "unverified";
}
