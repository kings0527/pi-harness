import { getStormConfig, setStormConfig } from "../core/storm/index.ts";

export default async function(pi: any) {
  pi.registerCommand("storm", {
    description: "Toggle storm mode (multi-model debate). Usage: /storm on <model1>,<model2> | /storm off | /storm (show status)",
    async handler(args: string, ctx: any) {
      const trimmed = args.trim();

      // /storm (no args) — show current status
      if (!trimmed) {
        const config = getStormConfig();
        const status = config.enabled
          ? `⚡ Storm mode: ON\n   Models: ${config.models.join(", ")}\n   Use \`spawn action=debate, topic="<topic>", question="<question>"\` to trigger.`
          : `Storm mode: OFF\n   Enable with: /storm on <model1>,<model2>`;
        pi.sendMessage({
          customType: "storm-status",
          content: status,
          display: "block",
        });
        return;
      }

      // /storm off
      if (trimmed === "off") {
        setStormConfig({ enabled: false, models: [] });
        pi.sendMessage({
          customType: "storm-status",
          content: "Storm mode disabled.",
          display: "block",
        });
        return;
      }

      // /storm on <model1>,<model2>
      if (trimmed.startsWith("on")) {
        const modelsStr = trimmed.slice(2).trim();
        if (!modelsStr) {
          pi.sendMessage({
            customType: "storm-status",
            content: "Usage: /storm on <model1>,<model2>\nExample: /storm on claude-sonnet-4,deepseek-r1",
            display: "block",
          });
          return;
        }
        const models = modelsStr.split(",").map((m: string) => m.trim()).filter(Boolean);
        if (models.length < 2) {
          pi.sendMessage({
            customType: "storm-status",
            content: "Storm requires at least 2 models for adversarial debate.\nExample: /storm on claude-sonnet-4,deepseek-r1",
            display: "block",
          });
          return;
        }
        setStormConfig({ enabled: true, models });
        pi.sendMessage({
          customType: "storm-status",
          content: `⚡ Storm mode enabled!\n   Models: ${models.join(", ")}\n   Advocate will use: ${models[0]}\n   Critic will use: ${models[1]}\n\n   The agent can now trigger debate via spawn action=debate when it hits a judgment call.`,
          display: "block",
        });
        return;
      }

      // Unknown subcommand
      pi.sendMessage({
        customType: "storm-status",
        content: "Unknown storm command.\nUsage: /storm on <model1>,<model2> | /storm off | /storm (status)",
        display: "block",
      });
    },
    getArgumentCompletions(prefix: string) {
      const completions = ["on ", "off"];
      return completions
        .filter(c => c.startsWith(prefix))
        .map(c => ({ label: c, value: c }));
    },
  });
}
