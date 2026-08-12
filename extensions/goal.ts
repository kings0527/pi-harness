import { getGoal, setGoal, updateGoal, clearGoal } from "../core/goal/index.ts";
import { appendEvent } from "../core/events/index.ts";

const GOAL_MESSAGE_TYPE = "pi-harness-goal";
const STALL_THRESHOLD = 50;

export default async function(pi: any) {
  // ─── (a) Slash Command ───────────────────────────────────────────────
  pi.registerCommand("goal", {
    description: "Set a persistent execution goal. Usage: /goal <condition> | /goal pause | /goal resume | /goal off | /goal (status)",
    async handler(args: string) {
      const trimmed = args.trim();

      // /goal (no args) — show status
      if (!trimmed) {
        const goal = getGoal();
        if (!goal || goal.status === "abandoned") {
          pi.sendMessage({ customType: "goal-status", content: "No active goal.\nSet one with: /goal <condition>", display: "block" });
        } else {
          const statusIcon = goal.status === "active" ? "🎯" : goal.status === "paused" ? "⏸" : "✅";
          pi.sendMessage({
            customType: "goal-status",
            content: `${statusIcon} Goal: ${goal.text}\n   Status: ${goal.status}\n   Turns: ${goal.turnCount}\n   Set: ${new Date(goal.createdAt).toLocaleString()}${goal.achievedAt ? `\n   Achieved: ${new Date(goal.achievedAt).toLocaleString()}` : ""}`,
            display: "block",
          });
        }
        return;
      }

      // /goal pause
      if (trimmed === "pause") {
        const goal = getGoal();
        if (!goal || goal.status !== "active") {
          pi.sendMessage({ customType: "goal-status", content: "No active goal to pause.", display: "block" });
          return;
        }
        updateGoal({ status: "paused" });
        pi.sendMessage({ customType: "goal-status", content: `⏸ Goal paused: ${goal.text}`, display: "block" });
        return;
      }

      // /goal resume
      if (trimmed === "resume") {
        const goal = getGoal();
        if (!goal || goal.status !== "paused") {
          pi.sendMessage({ customType: "goal-status", content: "No paused goal to resume.", display: "block" });
          return;
        }
        updateGoal({ status: "active" });
        pi.sendMessage({ customType: "goal-status", content: `🎯 Goal resumed: ${goal.text}`, display: "block" });
        return;
      }

      // /goal off
      if (trimmed === "off") {
        const goal = getGoal();
        if (!goal) {
          pi.sendMessage({ customType: "goal-status", content: "No goal to clear.", display: "block" });
          return;
        }
        updateGoal({ status: "abandoned" });
        clearGoal();
        pi.sendMessage({ customType: "goal-status", content: `Goal cleared: ${goal.text}`, display: "block" });
        appendEvent("goal_abandoned", { text: goal.text, turnCount: goal.turnCount });
        return;
      }

      // /goal <condition> — set new goal (overwrites any existing)
      setGoal(trimmed);
      pi.sendMessage({
        customType: "goal-status",
        content: `🎯 Goal set: ${trimmed}\n\n   This goal will persist in every turn until achieved or cleared.\n   Complete it by posting a Board note with tags=["goal-met"].`,
        display: "block",
      });
      appendEvent("goal_set", { text: trimmed });
    },
    getArgumentCompletions(prefix: string) {
      const completions = ["pause", "resume", "off"];
      return completions
        .filter(c => c.startsWith(prefix))
        .map(c => ({ label: c, value: c }));
    },
  });

  // ─── (b) Context Hook — reference message injection ──────────────────
  pi.on("context", async (event: any) => {
    if (!Array.isArray(event.messages)) return {};

    const goal = getGoal();
    if (!goal || goal.status !== "active") return {};

    // Increment turnCount
    updateGoal({ turnCount: goal.turnCount + 1 });

    // Stall warning at threshold (non-blocking)
    if (goal.turnCount + 1 >= STALL_THRESHOLD) {
      console.error(`[goal] WARN: goal "${goal.text}" has been active for ${goal.turnCount + 1} turns without completion — consider re-evaluating`);
      appendEvent("hook_warn", {
        rule: "goal-stall-guard",
        text: goal.text,
        turnCount: goal.turnCount + 1,
        message: `Goal active for ${goal.turnCount + 1} turns without completion`,
      });
    }

    // Filter out existing goal messages to avoid duplicates
    const messages = event.messages.filter(
      (message: any) => !(message.role === "custom" && message.customType === GOAL_MESSAGE_TYPE),
    );

    // Find last user message index
    let insertionIndex = messages.findLastIndex((message: any) => message.role === "user");
    if (insertionIndex < 0) insertionIndex = messages.length;

    // Splice in goal reference message
    messages.splice(insertionIndex, 0, {
      role: "custom",
      customType: GOAL_MESSAGE_TYPE,
      content: `[ACTIVE GOAL] ${goal.text}\n\nThis is your persistent execution target. Every action should serve this goal.\nProgress: turn ${goal.turnCount + 1} since goal was set.\nWhen fully achieved, post a Board note with tags=["goal-met"] containing evidence of completion.`,
      display: false,
      timestamp: Date.now(),
    });

    return { messages };
  });

  // ─── (c) Completion Detection — tool_call hook ───────────────────────
  pi.on("tool_call", async (event: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName !== "board") return;

    const input = event.input || event.args;
    if (input?.action !== "post") return;
    if (!Array.isArray(input?.tags) || !input.tags.includes("goal-met")) return;

    const goal = getGoal();
    if (!goal || goal.status !== "active") return;

    const achievedAt = Date.now();
    updateGoal({ status: "achieved", achievedAt });

    pi.sendMessage({
      customType: "goal-status",
      content: `✅ Goal achieved: ${goal.text}\n   Completed in ${goal.turnCount} turns.`,
      display: "block",
    });

    appendEvent("goal_achieved", {
      text: goal.text,
      turnCount: goal.turnCount,
      achievedAt,
    });
  });
}
