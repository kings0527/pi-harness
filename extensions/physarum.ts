import { getPhysarumConfig, setPhysarumConfig } from "../core/physarum/index.ts";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

function fuzzyMatchModel(shortName: string, available: ModelInfo[]): ModelInfo | null {
  const lower = shortName.toLowerCase().trim();
  if (!lower) return null;
  const exact = available.find(m => m.id.toLowerCase() === lower);
  if (exact) return exact;
  const withProvider = available.find(m =>
    `${m.provider}/${m.id}`.toLowerCase() === lower
  );
  if (withProvider) return withProvider;
  const byId = available.find(m => m.id.toLowerCase().includes(lower));
  if (byId) return byId;
  const byName = available.find(m => m.name.toLowerCase().includes(lower));
  if (byName) return byName;
  const byProvider = available.find(m => m.provider.toLowerCase().includes(lower));
  if (byProvider) return byProvider;
  return null;
}

function formatModelList(available: ModelInfo[]): string {
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
  pi.registerCommand("physarum", {
    description: "Toggle physarum mode (collective intelligence). Usage: /physarum on <models> | /physarum off | /physarum tentacles <N> | /physarum pulses <N> | /physarum (status)",
    async handler(args: string, ctx: any) {
      const trimmed = args.trim();

      // /physarum (no args) — show current status
      if (!trimmed) {
        const config = getPhysarumConfig();
        const status = config.enabled
          ? `🍄 Physarum mode: ON\n   Models: ${config.models.join(", ")}\n   Tentacles: ${config.tentacles ?? "auto"}\n   Pulses: ${config.maxPulses ?? "auto (3)"}\n   Use \`spawn action=physarum, topic="<topic>", question="<question>"\` to trigger.`
          : `Physarum mode: OFF\n   Enable with: /physarum on <model1>,<model2>`;
        pi.sendMessage({ customType: "physarum-status", content: status, display: "block" });
        return;
      }

      // /physarum off
      if (trimmed === "off") {
        setPhysarumConfig({ enabled: false, models: [] });
        pi.sendMessage({ customType: "physarum-status", content: "Physarum mode disabled.", display: "block" });
        return;
      }

      // /physarum tentacles <N>
      if (trimmed.startsWith("tentacles")) {
        const nStr = trimmed.slice("tentacles".length).trim();
        const n = parseInt(nStr, 10);
        if (isNaN(n) || n < 1 || n > 6) {
          pi.sendMessage({ customType: "physarum-status", content: "Error: tentacles must be 1-6.\nUsage: /physarum tentacles <N>", display: "block" });
          return;
        }
        const config = getPhysarumConfig();
        setPhysarumConfig({ ...config, tentacles: n });
        pi.sendMessage({ customType: "physarum-status", content: `Tentacles set to ${n}.`, display: "block" });
        return;
      }

      // /physarum pulses <N>
      if (trimmed.startsWith("pulses")) {
        const nStr = trimmed.slice("pulses".length).trim();
        const n = parseInt(nStr, 10);
        if (isNaN(n) || n < 1 || n > 5) {
          pi.sendMessage({ customType: "physarum-status", content: "Error: pulses must be 1-5.\nUsage: /physarum pulses <N>", display: "block" });
          return;
        }
        const config = getPhysarumConfig();
        setPhysarumConfig({ ...config, maxPulses: n });
        pi.sendMessage({ customType: "physarum-status", content: `Max pulses set to ${n}.`, display: "block" });
        return;
      }

      // /physarum on [<model1>,<model2>]
      if (trimmed.startsWith("on")) {
        const modelsStr = trimmed.slice(2).trim();
        const available: ModelInfo[] = ctx.modelRegistry
          ? ctx.modelRegistry.getAvailable().map((m: any) => ({ id: m.id, name: m.name, provider: m.provider }))
          : [];

        // /physarum on (no models) → auto-select first 2
        if (!modelsStr) {
          if (available.length === 0) {
            pi.sendMessage({ customType: "physarum-status", content: "No models available. Configure API keys first.\nUsage: /physarum on <model1>,<model2>", display: "block" });
          } else {
            const autoModels = available.slice(0, 2).map(m => m.id);
            const config = getPhysarumConfig();
            setPhysarumConfig({ ...config, enabled: true, models: autoModels });
            pi.sendMessage({ customType: "physarum-status", content: `🍄 Physarum mode enabled (auto)!\n   Models: ${autoModels.join(", ")}\n\nAvailable:\n${formatModelList(available)}`, display: "block" });
          }
          return;
        }

        const shortNames = modelsStr.split(",").map((m: string) => m.trim()).filter(Boolean);
        // Physarum allows 1+ models (unlike storm which requires ≥2)
        if (shortNames.length < 1) {
          pi.sendMessage({ customType: "physarum-status", content: "Provide at least 1 model.\nExample: /physarum on claude-sonnet-4", display: "block" });
          return;
        }

        // Fuzzy resolve
        if (available.length === 0) {
          const config = getPhysarumConfig();
          setPhysarumConfig({ ...config, enabled: true, models: shortNames });
          pi.sendMessage({ customType: "physarum-status", content: `🍄 Physarum mode enabled!\n   Models: ${shortNames.join(", ")}\n   (Could not verify model IDs — registry unavailable)`, display: "block" });
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
          pi.sendMessage({ customType: "physarum-status", content: `Cannot find models matching: ${unmatched.join(", ")}\n\nAvailable:\n${formatModelList(available)}\n\nTip: use partial names like "claude", "deepseek", "qwen"`, display: "block" });
          return;
        }

        const config = getPhysarumConfig();
        setPhysarumConfig({ ...config, enabled: true, models: resolved });
        const matchInfo = shortNames.map((s: string, i: number) =>
          s === resolved[i] ? resolved[i] : `${s} → ${resolved[i]}`
        ).join(", ");
        pi.sendMessage({ customType: "physarum-status", content: `🍄 Physarum mode enabled!\n   Models: ${matchInfo}\n\n   Use \`spawn action=physarum, topic="<topic>", question="<q>", angles=["a","b",...]\` to explore.`, display: "block" });
        return;
      }

      // Unknown subcommand
      pi.sendMessage({ customType: "physarum-status", content: "Unknown physarum command.\nUsage: /physarum on <models> | /physarum off | /physarum tentacles <N> | /physarum pulses <N> | /physarum (status)", display: "block" });
    },
    getArgumentCompletions(prefix: string) {
      const completions = ["on ", "off", "tentacles ", "pulses "];
      return completions
        .filter(c => c.startsWith(prefix))
        .map(c => ({ label: c.trim(), value: c }));
    },
  });
}
