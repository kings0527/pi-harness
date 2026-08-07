// ADR-0009 (revised): anti-drift runtime hook — WARNING ONLY.
//
// Philosophy (revised after first review):
// - The LLM is trusted. It may explore, repeat, or "monkey-sort" if that is the
//   right move. We do NOT gatekeep by counting steps, tokens, neutrals, or
//   equivalence runs.
// - This hook's only job: detect when a tool call matches the immediately
//   previous call (same fingerprint) and emit a human-visible warning. The
//   warning goes to stderr + events.jsonl. It does NOT go into the model's
//   context — the model already knows what it is doing.
// - The 4 anti-drift principles live in prompts/anti-drift.md and are always
//   in the system prompt. They are judgment guidance for the LLM, not
//   runtime gates. No mode switching. No state injection. No thresholds.

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendEvent } from "../core/events/index.ts";
import { fingerprint } from "../core/anti-drift/fingerprint.ts";

const STATE_DIR = join(process.cwd(), ".pi-board", "anti-drift");
const MAX_RECENT = 8; // small ring; only used to detect "same as last 1"

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function sanitizeSessionId(raw: string): string {
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return safe.length > 0 ? safe : "unknown";
}

function getSessionId(): string {
  return sanitizeSessionId(process.env.PI_SESSION_ID || `pid-${process.pid}`);
}

function loadRecent(sessionId: string): string[] {
  ensureStateDir();
  const p = join(STATE_DIR, `${sessionId}.json`);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(data.recent) ? data.recent : [];
  } catch {
    return [];
  }
}

function saveRecent(sessionId: string, recent: string[]): void {
  ensureStateDir();
  const p = join(STATE_DIR, `${sessionId}.json`);
  writeFileSync(p, JSON.stringify({ recent }), "utf-8");
}

export default async function (pi: any) {
  // Per-session disabled flag. Off by default; on demand, the operator can
  // silence all anti-drift side effects with PI_ANTIDRIFT_DISABLED=1.
  function isDisabled(): boolean {
    return process.env.PI_ANTIDRIFT_DISABLED === "1";
  }

  // Detect "exact repeat of the immediately previous call" and warn.
  // We deliberately do NOT check beyond the last 1 — even an A,B,A pattern
  // (intentional oscillation) is the LLM's business, not ours.
  pi.on("tool_call", async (event: any, _ctx: any) => {
    if (isDisabled()) return;
    const toolName = (event.tool || event.toolName || "").toLowerCase();
    if (!toolName) return;
    const input = event.input || event.args || {};
    const fp = fingerprint({ tool: toolName, input });
    const sessionId = getSessionId();
    const recent = loadRecent(sessionId);
    const last = recent[recent.length - 1];

    // Always update the ring (after the check so a brand-new action still
    // gets recorded).
    const next = [...recent, fp].slice(-MAX_RECENT);
    saveRecent(sessionId, next);

    if (last === fp) {
      const message = `Same action as previous turn (${fp}). If intentional, no action needed. If accidental, change hypothesis, tool, layer, granularity, or observation point.`;
      console.error(`[anti-drift] ${message}`);
      appendEvent("hook_warn", {
        rule: "anti-drift-repeat-action",
        session: sessionId,
        tool: toolName,
        fingerprint: fp,
        message,
      });
    }
  });
}
