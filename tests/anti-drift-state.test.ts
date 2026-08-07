// ADR-0009: state machine tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyState,
  recordAction,
  isEquivalent,
  recordNeutral,
  recordNonNeutral,
  exitStrict,
  toCompact,
  DEFAULT_NEUTRAL_THRESHOLD,
} from "../core/anti-drift/state.ts";

test("emptyState initializes MONITOR with zero counters", () => {
  const s = emptyState("s1");
  assert.equal(s.mode, "MONITOR");
  assert.equal(s.neutralStreak, 0);
  assert.equal(s.turnCount, 0);
  assert.deepEqual(s.recentFingerprints, []);
});

test("recordAction appends fingerprint, caps at MAX_RECENT_FINGERPRINTS", () => {
  let s = emptyState("s2");
  for (let i = 0; i < 25; i++) s = recordAction(s, `fp-${i}`);
  assert.equal(s.recentFingerprints.length, 20);
  assert.equal(s.recentFingerprints[0], "fp-5");
  assert.equal(s.recentFingerprints[19], "fp-24");
  assert.equal(s.turnCount, 25);
});

test("isEquivalent: A,A detected; A,B,A not; A,B,C not", () => {
  let s = emptyState("s3");
  s = recordAction(s, "A");
  assert.equal(isEquivalent(s, "A"), true, "A after A is equivalent");
  s = recordAction(s, "B");
  assert.equal(isEquivalent(s, "A"), false, "A after B is not equivalent");
  s = recordAction(s, "A");
  assert.equal(isEquivalent(s, "A"), true, "A after B,A is equivalent");
  s = recordAction(s, "C");
  assert.equal(isEquivalent(s, "A"), false);
});

test("isEquivalent on empty history returns false", () => {
  const s = emptyState("s4");
  assert.equal(isEquivalent(s, "A"), false);
});

test("recordNeutral increments streak and escalates to STRICT at threshold", () => {
  let s = emptyState("s5");
  for (let i = 0; i < DEFAULT_NEUTRAL_THRESHOLD - 1; i++) s = recordNeutral(s);
  assert.equal(s.mode, "MONITOR");
  s = recordNeutral(s);
  assert.equal(s.mode, "STRICT");
  assert.equal(s.neutralStreak, DEFAULT_NEUTRAL_THRESHOLD);
});

test("recordNonNeutral resets streak but does NOT exit STRICT (conservative)", () => {
  let s = emptyState("s6");
  for (let i = 0; i < DEFAULT_NEUTRAL_THRESHOLD; i++) s = recordNeutral(s);
  assert.equal(s.mode, "STRICT");
  s = recordNonNeutral(s);
  assert.equal(s.neutralStreak, 0);
  assert.equal(s.mode, "STRICT", "STRICT only exits via exitStrict, not via non-neutral alone");
});

test("exitStrict returns to MONITOR and clears streak", () => {
  let s = emptyState("s7");
  s = recordAction(s, "X");
  s = recordNeutral(s);
  s = recordNeutral(s);
  s = recordNeutral(s);
  assert.equal(s.mode, "STRICT");
  s = exitStrict(s);
  assert.equal(s.mode, "MONITOR");
  assert.equal(s.neutralStreak, 0);
});

test("exitStrict on MONITOR is a no-op (same reference)", () => {
  const s = emptyState("s8");
  assert.equal(exitStrict(s), s);
});

test("toCompact produces a short, parseable snapshot", () => {
  let s = emptyState("s9");
  s = recordAction(s, "read|path=/x");
  s = recordNeutral(s);
  s = recordNeutral(s);
  const compact = toCompact(s);
  assert.match(compact, /^mode=MONITOR/);
  assert.match(compact, /streak=2/);
  assert.match(compact, /last=read\|path=\/x/);
  // Cap: with our content, well under 300 bytes.
  assert.ok(compact.length < 200, `compact too long: ${compact.length}`);
});
