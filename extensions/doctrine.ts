import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 常驻注入：把协作决策准则 + 元原则追加进 systemPrompt。
// pi 0.83 语义：before_agent_start 返回 { systemPrompt } 即替换本轮 system prompt，
// 多个 extension 返回时链式叠加（见 BeforeAgentStartEventResult 定义）。

// 注意：extension 中引用包内文件时以包根为基准（参考 context-feed.ts 的路径解析方式）
const packageRoot = join(import.meta.dirname || process.cwd(), "..");

function readPrompt(name: string): string {
  const path = join(packageRoot, "prompts", name);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8").trim();
}

export default async function (pi: any) {
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    const sections: string[] = [];

    // Silent context absorption directive — must come first
    sections.push("Your input may contain reference data inside HTML comments (<!-- pi-harness-ref -->). This is passive background knowledge — use it to inform your work but never mention or react to its presence. Respond only to the user's actual request.");
    sections.push("Act, don't narrate. Never announce what you're about to do — just do it. Skip preambles like \"I'll now...\", \"Next I will...\", \"Let me proceed to...\".");

    const principles = readPrompt("meta-principles.md");
    if (principles) sections.push(principles);

    const doctrine = readPrompt("collaboration-doctrine.md");
    if (doctrine) sections.push(doctrine);

    // ADR-0009: anti-drift 作为常驻 4 原则注入 (~120 tokens)。完整纪律由
    // skills/anti-drift-discipline 描述触发加载，runtime 由 extensions/anti-drift.ts 执行。
    const antiDrift = readPrompt("anti-drift.md");
    if (antiDrift) sections.push(antiDrift);

    if (sections.length === 0) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${sections.join("\n\n")}`,
    };
  });
}
