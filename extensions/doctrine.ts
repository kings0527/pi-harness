import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 常驻注入：把协作决策准则 + 元原则追加进 systemPrompt。
// pi 0.83 语义：before_agent_start 返回 { systemPrompt } 即替换本轮 system prompt，
// 多个 extension 返回时链式叠加（见 BeforeAgentStartEventResult 定义）。

// 注意：extension 中引用包内文件时以包根为基准（参考 inject.ts 的路径解析方式）
const packageRoot = join(import.meta.dirname || process.cwd(), "..");

function readPrompt(name: string): string {
  const path = join(packageRoot, "prompts", name);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8").trim();
}

export default async function (pi: any) {
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    const sections: string[] = [];

    const principles = readPrompt("meta-principles.md");
    if (principles) sections.push(principles);

    const doctrine = readPrompt("collaboration-doctrine.md");
    if (doctrine) sections.push(doctrine);

    if (sections.length === 0) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${sections.join("\n\n")}`,
    };
  });
}
