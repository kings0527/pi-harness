import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessContextSize } from "../core/context-size/index.ts";
import { appendEvent } from "../core/events/index.ts";
import {
  beginGoalTurn,
  clearGoal,
  completeGoalFromBoardNote,
  createGoalReferenceSnapshot,
  getGoal,
  goalEvidenceTag,
  pauseGoal,
  resumeGoal,
  setGoal,
  GOAL_MET_TAG,
  type GoalReferenceSnapshot,
} from "../core/goal/index.ts";

const GOAL_MESSAGE_TYPE = "pi-harness-goal";
const LEGACY_STATUS_MESSAGE_TYPE = "goal-status";
const GOAL_SNAPSHOT_ENTRY_TYPE = "pi-harness-goal-snapshot";

type GoalMarkerStatus = "active" | "paused" | "achieved" | "cleared" | "inactive";

interface GoalMarker {
  goalId: string;
  sessionId: string;
  status: GoalMarkerStatus;
  snapshotId?: string;
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, level);
}

function activeGoalMessage(snapshot: GoalReferenceSnapshot) {
  return {
    customType: GOAL_MESSAGE_TYPE,
    content: snapshot.content,
    display: false,
    details: {
      sessionId: snapshot.sessionId,
      goalId: snapshot.goalId,
      status: "active" as const,
      snapshotId: snapshot.id,
      path: snapshot.path,
      bytes: snapshot.bytes,
      userTurnCount: snapshot.userTurnCount,
      frozenAt: snapshot.frozenAt,
    },
  };
}

function inactiveGoalMessage(currentSessionId: string, marker: GoalMarker, status: Exclude<GoalMarkerStatus, "active">) {
  return {
    customType: GOAL_MESSAGE_TYPE,
    content: [
      `<goal_state id="${marker.goalId}" scope="current-session" status="${status}">`,
      "<instruction>This goal is not active in this session. Do not treat it as the current execution target.</instruction>",
      "</goal_state>",
    ].join("\n"),
    display: false,
    details: {
      sessionId: currentSessionId,
      goalId: marker.goalId,
      status,
    },
  };
}

function latestGoalMarker(entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): GoalMarker | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom_message" || entry.customType !== GOAL_MESSAGE_TYPE) continue;
    const details = entry.details as Partial<GoalMarker> | undefined;
    if (!details || typeof details.goalId !== "string" || typeof details.sessionId !== "string") continue;
    if (!details.status || !["active", "paused", "achieved", "cleared", "inactive"].includes(details.status)) continue;
    return details as GoalMarker;
  }
  return null;
}

export default async function goalExtension(pi: ExtensionAPI) {
  const warnedGoalIds = new Set<string>();

  pi.registerCommand("goal", {
    description: "Set a session-persistent execution goal. Usage: /goal <condition> | pause | resume | off | status",
    async handler(args, ctx) {
      const id = sessionId(ctx);
      const trimmed = args.trim();

      if (!trimmed || trimmed === "status") {
        const goal = getGoal(id);
        if (!goal) {
          notify(ctx, "No goal in this session. Set one with /goal <condition>.");
          return;
        }
        const evidence = goal.evidence ? `\nEvidence: Board ${goal.evidence.topic}#${goal.evidence.noteSeq}` : "";
        notify(
          ctx,
          `Goal: ${goal.text}\nStatus: ${goal.status}\nUser turns: ${goal.userTurnCount}\nID: ${goal.id}${evidence}`,
        );
        return;
      }

      if (trimmed === "pause") {
        const paused = pauseGoal(id);
        notify(ctx, paused ? `Goal paused: ${paused.text}` : "No active goal to pause.", paused ? "info" : "warning");
        return;
      }

      if (trimmed === "resume") {
        const resumed = resumeGoal(id);
        notify(ctx, resumed ? `Goal resumed: ${resumed.text}` : "No paused goal to resume.", resumed ? "info" : "warning");
        return;
      }

      if (trimmed === "off") {
        const cleared = clearGoal(id);
        notify(ctx, cleared ? `Goal cleared: ${cleared.text}` : "No goal to clear.", cleared ? "info" : "warning");
        return;
      }

      const goal = setGoal(id, trimmed);
      notify(
        ctx,
        `Goal set: ${goal.text}\nCompletion tags: ${GOAL_MET_TAG}, ${goalEvidenceTag(goal.id)}`,
      );

      // Slash commands are consumed by Pi and otherwise vanish from the
      // transcript. Re-submit the exact visible command as a real user message;
      // Pi skips command expansion for extension-originated user messages, fires
      // before_agent_start, persists the turn, and starts execution immediately.
      if (!ctx.isIdle()) await ctx.waitForIdle();
      const latest = getGoal(id);
      if (latest?.id === goal.id && latest.status === "active") {
        pi.sendUserMessage(`/goal ${trimmed}`);
      }
    },
    getArgumentCompletions(prefix) {
      return ["status", "pause", "resume", "off"]
        .filter(command => command.startsWith(prefix))
        .map(command => ({ label: command, value: command }));
    },
  });

  // Persist only state changes. Rewriting/moving an ephemeral goal message would
  // cut the provider cache prefix at the previous user turn (ADR-0016).
  pi.on("before_agent_start", async (_event, ctx) => {
    const id = sessionId(ctx);
    const current = getGoal(id);
    const latestActive = latestGoalMarker(ctx.sessionManager.buildContextEntries());
    const latestHistorical = latestGoalMarker(ctx.sessionManager.getBranch());
    if (!current || current.status !== "active") {
      const basis = latestHistorical ?? (current ? {
        sessionId: id,
        goalId: current.id,
        status: current.status,
      } as GoalMarker : null);
      if (!basis) return;
      const status: Exclude<GoalMarkerStatus, "active"> = current
        ? current.status as "paused" | "achieved"
        : basis.sessionId === id ? "cleared" : "inactive";
      if (latestActive?.sessionId === id
        && latestActive.goalId === basis.goalId
        && latestActive.status === status) return;
      return { message: inactiveGoalMessage(id, basis, status) };
    }

    const advanced = beginGoalTurn(id, current.id);
    if (!advanced) {
      return;
    }

    const snapshot = createGoalReferenceSnapshot(advanced);
    const metadata = {
      sessionId: id,
      goalId: advanced.id,
      snapshotId: snapshot.id,
      path: snapshot.path,
      bytes: snapshot.bytes,
      userTurnCount: snapshot.userTurnCount,
      frozenAt: snapshot.frozenAt,
    };
    pi.appendEntry(GOAL_SNAPSHOT_ENTRY_TYPE, metadata);
    appendEvent("goal_snapshot", metadata);

    const contextWindow = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
    if (contextWindow && !warnedGoalIds.has(advanced.id)) {
      const assessment = assessContextSize(snapshot.content, contextWindow);
      if (assessment.shouldWarn) {
        warnedGoalIds.add(advanced.id);
        const message = `Goal reference is ~${assessment.estimatedTokens} tokens (${(assessment.ratio * 100).toFixed(1)}% of ${contextWindow}); full text preserved.`;
        console.error(`[goal] WARN: ${message}`);
        appendEvent("hook_warn", {
          rule: "goal-context-size",
          sessionId: id,
          goalId: advanced.id,
          ...assessment,
          message,
        });
      }
    }

    if (latestActive?.sessionId === id
      && latestActive.goalId === advanced.id
      && latestActive.status === "active"
      && latestActive.snapshotId === snapshot.id) {
      return;
    }
    return { message: activeGoalMessage(snapshot) };
  });

  // One-time migration cleanup for old TUI status messages. Persistent goal
  // lifecycle markers remain untouched and therefore append-only.
  pi.on("context", async event => {
    const messages = event.messages.filter(
      message => !(message.role === "custom" && message.customType === LEGACY_STATUS_MESSAGE_TYPE),
    );
    return messages.length === event.messages.length ? {} : { messages };
  });

  // Completion is evaluated only after Board execution and verified against the persisted note.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "board" || event.isError) return;
    const input = event.input as { action?: unknown; topic?: unknown; tags?: unknown };
    if (input.action !== "post" || typeof input.topic !== "string" || !Array.isArray(input.tags)) return;
    if (!input.tags.includes(GOAL_MET_TAG)) return;

    const details = event.details as { action?: string; topic?: string; noteSeq?: unknown } | undefined;
    const noteSeq = details?.noteSeq;
    if (details?.action !== "post" || details.topic !== input.topic || typeof noteSeq !== "number" || !Number.isInteger(noteSeq)) return;
    const id = sessionId(ctx);
    const current = getGoal(id);
    if (!current || current.status !== "active" || !input.tags.includes(goalEvidenceTag(current.id))) return;

    const completed = completeGoalFromBoardNote(id, current.id, input.topic, noteSeq);
    if (!completed) return;
    notify(ctx, `Goal achieved: ${completed.text}`);
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `Goal ${completed.id} verified and marked achieved from Board ${input.topic}#${noteSeq}.`,
        },
      ],
    };
  });
}
