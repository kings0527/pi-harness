// ADR-0009: anti-drift state machine.
// Pure data, runtime-agnostic. No pi imports. Stored as JSON in .pi-board/anti-drift/<sessionId>.json

export type DriftMode = "MONITOR" | "STRICT";

export interface DriftState {
  sessionId: string;
  mode: DriftMode;
  // last few action fingerprints (for equivalence detection)
  recentFingerprints: string[];
  // count of consecutive neutral actions; reset on non-neutral
  neutralStreak: number;
  // turn count for stall threshold math
  turnCount: number;
  // last updated
  updatedAt: number;
}

export const DEFAULT_NEUTRAL_THRESHOLD = 3; // N consecutive neutrals → STRICT
export const MAX_RECENT_FINGERPRINTS = 20;

export function emptyState(sessionId: string): DriftState {
  return {
    sessionId,
    mode: "MONITOR",
    recentFingerprints: [],
    neutralStreak: 0,
    turnCount: 0,
    updatedAt: Date.now(),
  };
}

export function recordAction(state: DriftState, fingerprint: string): DriftState {
  const next: DriftState = {
    ...state,
    recentFingerprints: [...state.recentFingerprints, fingerprint].slice(-MAX_RECENT_FINGERPRINTS),
    turnCount: state.turnCount + 1,
    updatedAt: Date.now(),
  };
  return next;
}

export function isEquivalent(state: DriftState, fingerprint: string): boolean {
  // Equivalent if the same fingerprint appears in the last 2 (current turn + previous).
  // Tighter than a long-window check: tolerates the "I tried A, then B, then re-tried A" pattern
  // which is legitimate, but catches the "A, A, A" loop.
  const last = state.recentFingerprints[state.recentFingerprints.length - 1];
  if (last === undefined) return false;
  const prev = state.recentFingerprints[state.recentFingerprints.length - 2];
  if (fingerprint === last) return true;
  // A → B → A is fine; A → A is not.
  if (prev === undefined) return false;
  return fingerprint === prev && fingerprint === last;
}

export function recordNeutral(state: DriftState): DriftState {
  const streak = state.neutralStreak + 1;
  return {
    ...state,
    neutralStreak: streak,
    mode: streak >= DEFAULT_NEUTRAL_THRESHOLD ? "STRICT" : state.mode,
    updatedAt: Date.now(),
  };
}

export function recordNonNeutral(state: DriftState): DriftState {
  if (state.neutralStreak === 0 && state.mode === "MONITOR") return state;
  return {
    ...state,
    neutralStreak: 0,
    // STRICT only exits on an explicit "I changed hypothesis / layer / tool" event, not just on a
    // non-neutral action. This is conservative; the next neutral streak re-triggers.
    updatedAt: Date.now(),
  };
}

export function exitStrict(state: DriftState): DriftState {
  if (state.mode === "MONITOR") return state;
  return {
    ...state,
    mode: "MONITOR",
    neutralStreak: 0,
    updatedAt: Date.now(),
  };
}

// Serialize a compact snapshot for context injection (≤ 300 bytes by construction).
export function toCompact(state: DriftState): string {
  const parts: string[] = [];
  parts.push(`mode=${state.mode}`);
  parts.push(`streak=${state.neutralStreak}`);
  if (state.recentFingerprints.length > 0) {
    const last = state.recentFingerprints[state.recentFingerprints.length - 1];
    // Truncate fingerprint to keep the snapshot bounded regardless of path length.
    parts.push(`last=${last.length > 80 ? last.slice(0, 77) + "..." : last}`);
  }
  return parts.join(" ");
}
