// ADR-0009: public surface for core/anti-drift.
export {
  emptyState,
  recordAction,
  isEquivalent,
  recordNeutral,
  recordNonNeutral,
  exitStrict,
  toCompact,
  DEFAULT_NEUTRAL_THRESHOLD,
} from "./state.ts";
export type { DriftState, DriftMode } from "./state.ts";

export { fingerprint } from "./fingerprint.ts";
export type { FingerprintInput } from "./fingerprint.ts";

export { classify } from "./evidence.ts";
export type { EvidenceDelta, EvidenceInput } from "./evidence.ts";
