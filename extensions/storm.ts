import { getStormConfig, setStormConfig } from "../core/storm/index.ts";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

function fuzzyMatchModel(shortName: string, available: ModelInfo[]): ModelInfo | null {
  const lower = shortName.toLowerCase().trim();
  if (!lower) return null;
  // Exact id match
  const exact = available.find(m => m.id.toLowerCase() === lower);
  if (exact) return exact;
  // provider/id format
  const withProvider = available.find(m =>
    `${m.provider}/${m.id}`.toLowerCase() === lower
  );
  if (withProvider) return withProvider;
  // id contains shortName
  const byId = available.find(m => m.id.toLowerCase().includes(lower));
  if (byId) return byId;
  // name contains shortName
  const byName = available.find(m => m.name.toLowerCase().includes(lower));
  if (byName) return byName;
  // provider contains shortName
  const byProvider = available.find(m => m.provider.toLowerCase().includes(lower));
  if (byProvider) return byProvider;
  return null;
}

function formatModelList(available: ModelInfo[]): string {
  // Group by provider
  const grouped: Record<string, string[]> = {};
  for (const m of available) {
    if (!grouped[m.provider]) grouped[m.provider] = [];
    grouped[m.provider].push(m.id);
  }
  const lines: string[] = [];
  for (const [provider, ids] of Object.entries(grouped)) {
    lines.push(`  [${provider}]`);
    for (const id of ids) {
      lines.push(`    - ${id}`);
    }
  }
  return lines.join("\n");
}

export default async function(pi: any) {
  pi.registerCommand("storm", {
    description: "Toggle storm mode (multi-model debate). Usage: /storm on <model1>,<model2> | /storm off | /storm on (list models) | /storm (status)",
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

      // /storm on [<model1>,<model2>]
      if (trimmed.startsWith("on")) {
        const modelsStr = trimmed.slice(2).trim();
        const available: ModelInfo[] = ctx.modelRegistry
          ? ctx.modelRegistry.getAvailable().map((m: any) => ({ id: m.id, name: m.name, provider: m.provider }))
          : [];

        // /storm on (no models) → list available
        if (!modelsStr) {
          if (available.length === 0) {
            pi.sendMessage({
              customType: "storm-status",
              content: "No models available. Configure API keys first.\nUsage: /storm on <model1>,<model2>",
              display: "block",
            });
          } else {
            pi.sendMessage({
              customType: "storm-status",
              content: `Available models (use short names for fuzzy match):\n\n${formatModelList(available)}\n\nUsage: /storm on <model1>,<model2>\nExample: /storm on claude,deepseek`,
              display: "block",
            });
          }
          return;
        }

        const shortNames = modelsStr.split(",").map((m: string) => m.trim()).filter(Boolean);
        if (shortNames.length < 2) {
          pi.sendMessage({
            customType: "storm-status",
            content: "Storm requires at least 2 models for adversarial debate.\nExample: /storm on claude-sonnet-4,deepseek-r1",
            display: "block",
          });
          return;
        }

        // Fuzzy resolve each model
        if (available.length === 0) {
          // No registry access — fall back to raw names
          setStormConfig({ enabled: true, models: shortNames });
          pi.sendMessage({
            customType: "storm-status",
            content: `⚡ Storm mode enabled!\n   Models: ${shortNames.join(", ")}\n   (Could not verify model IDs — registry unavailable)\n\n   Advocate: ${shortNames[0]}\n   Critic: ${shortNames[1]}`,
            display: "block",
          });
          return;
        }

        const unmatched: string[] = [];
        const resolved: string[] = [];
        for (const name of shortNames) {
          const match = fuzzyMatchModel(name, available);
          if (match) {
            resolved.push(match.id);
          } else {
            unmatched.push(name);
          }
        }

        if (unmatched.length > 0) {
          pi.sendMessage({
            customType: "storm-status",
            content: `Cannot find models matching: ${unmatched.join(", ")}\n\nAvailable:\n${formatModelList(available)}\n\nTip: use partial names like "claude", "deepseek", "qwen"`,
            display: "block",
          });
          return;
        }

        setStormConfig({ enabled: true, models: resolved });
        const matchInfo = shortNames.map((s: string, i: number) =>
          s === resolved[i] ? resolved[i] : `${s} → ${resolved[i]}`
        ).join(", ");
        pi.sendMessage({
          customType: "storm-status",
          content: `⚡ Storm mode enabled!\n   Models: ${matchInfo}\n   Advocate: ${resolved[0]}\n   Critic: ${resolved[1]}\n\n   The agent can now trigger debate via spawn action=debate when it hits a judgment call.`,
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
