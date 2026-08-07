// ADR-0009: anti-drift runtime hook.
// Same shape as extensions/discipline.ts and extensions/convergence.ts:
// - process-local session state (cheap, no persistence beyond JSON)
// - tool_call / tool_result hooks
// - write to events.jsonl via core/events
// - block only on hard invariant violation; otherwise warn

import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { appendEvent } from "../core/events/index.ts";
import {
  emptyState,
  recordAction,
  isEquivalent,
  recordNeutral,
  recordNonNeutral,
  exitStrict,
  toCompact,
  fingerprint,
  classify,
  type DriftState,
} from "../core/anti-drift/index.ts";

const STATE_DIR = join(process.cwd(), ".pi-board", "anti-drift");

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function statePath(sessionId: string): string {
  return join(STATE_DIR, `${sessionId}.json`);
}

function loadState(sessionId: string): DriftState {
  ensureStateDir();
  const p = statePath(sessionId);
  if (!existsSync(p)) return emptyState(sessionId);
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as DriftState;
  } catch {
    return emptyState(sessionId);
  }
}

function saveState(state: DriftState): void {
  ensureStateDir();
  writeFileSync(statePath(state.sessionId), JSON.stringify(state), "utf-8");
}

export default async function (pi: any) {
  function getSessionId(): string {
    // pi exposes session id via process.env; fall back to pid.
    return process.env.PI_SESSION_ID || `pid-${process.pid}`;
  }
  // Re-read state per call so session_id changes (e.g. between tests) take effect.
  function currentState(): DriftState {
    return loadState(getSessionId());
  }
  // Rolling buffer of recent outputs (per tool) for shape-hash comparison.
  // Keyed by sessionId so concurrent sessions don't cross-contaminate.
  const recentOutputsBySession = new Map<string, Map<string, string[]>>();
  function getRecentOutputs(sessionId: string): Map<string, string[]> {
    let m = recentOutputsBySession.get(sessionId);
    if (!m) {
      m = new Map();
      recentOutputsBySession.set(sessionId, m);
    }
    return m;
  }
  const OUTPUT_BUFFER_MAX = 4;

  // Restore on session start.
  pi.on("session_start", async () => {
    loadState(getSessionId());
  });

  // Detect equivalent actions. Warn only — never block; the LLM may legitimately retry.
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const toolName = (event.tool || event.toolName || "").toLowerCase();
    if (!toolName) return;
    const input = event.input || event.args || {};
    const fp = fingerprint({ tool: toolName, input });
    const sessionId = getSessionId();
    const state = currentState();

    if (isEquivalent(state, fp)) {
      const message = `Equivalent action detected (${fp}). Either change hypothesis, tool, layer, granularity, or observation point — or state the new information this invocation is expected to produce.`;
      console.error(`[anti-drift] WARN: ${message}`);
      appendEvent("hook_warn", {
        rule: "anti-drift-equivalent-action",
        session: sessionId,
        tool: toolName,
        fingerprint: fp,
        message,
      });
    }

    saveState(recordAction(state, fp));
  });

  // Classify the result. NEUTRAL feeds the streak counter.
  pi.on("tool_result", async (event: any, _ctx: any) => {
    const toolName = (event.tool || event.toolName || "").toLowerCase();
    if (!toolName) return;
    const output = (event.content ?? event.output ?? event.result ?? "");
    const outputStr = typeof output === "string" ? output : JSON.stringify(output);

    const sessionId = getSessionId();
    const state = currentState();
    const recentOutputs = getRecentOutputs(sessionId);
    const buf = recentOutputs.get(toolName) ?? [];
    const delta = classify({ tool: toolName, output: outputStr, previousOutputs: buf });
    buf.push(outputStr);
    while (buf.length > OUTPUT_BUFFER_MAX) buf.shift();
    recentOutputs.set(toolName, buf);

    if (delta === "NEUTRAL") {
      const before = state.mode;
      const next = recordNeutral(state);
      if (next.mode !== before) {
        const message = `Entered STRICT mode after ${next.neutralStreak} consecutive neutral actions. Change one of {hypothesis, layer, tool, input, granularity, observation point}.`;
        console.error(`[anti-drift] ${message}`);
        appendEvent("hook_warn", {
          rule: "anti-drift-stall-strict",
          session: sessionId,
          neutralStreak: next.neutralStreak,
          message,
        });
      }
      saveState(next);
    } else {
      if (state.neutralStreak > 0) {
        saveState(recordNonNeutral(state));
      }
    }
  });

  // Exit STRICT: any after_agent (end of turn) while in STRICT exits it.
  // The LLM's next action will re-trigger if it's still looping.
  pi.on("after_agent", async () => {
    const state = currentState();
    if (state.mode === "STRICT") {
      saveState(exitStrict(state));
    }
  });

  // Context injection: append a compact state snapshot to the last user message,
  // matching the pattern in extensions/context-feed.ts. Capped at 300 bytes
  // by toCompact()'s construction.
  pi.on("context", async (event: any, _ctx: any) => {
    if (!event.messages || !Array.isArray(event.messages)) return;
    const snapshot = toCompact(currentState());
    if (!snapshot) return;
    const block = `\n<!-- anti-drift: ${snapshot} -->`;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i];
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") {
        msg.content += block;
        break;
      }
      if (Array.isArray(msg.content)) {
        const last = msg.content.findLast((p: any) => p.type === "text");
        if (last) last.text += block;
        else msg.content.push({ type: "text", text: block });
        break;
      }
    }
  });
}
