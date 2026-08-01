import { spawn } from "node:child_process";
import { appendEvent } from "../events/index.ts";
import { listTopics } from "../board/index.ts";
import { renderSystemPrompt } from "../identity/index.ts";
import type { AgentProfile } from "../identity/index.ts";

export interface SpawnOptions {
  profile: AgentProfile;
  topic: string;
  task: string; // 分派给该 subagent 的具体调查任务
  cwd?: string;
  timeoutMs?: number; // 默认 10 分钟
}

export interface SpawnResult {
  name: string;
  exitCode: number | null;
  output: string; // stdout 尾部（截断到合理长度）
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4000;

function buildPrompt(opts: SpawnOptions): string {
  const topics = listTopics();
  const meta = topics.find(t => t.id === opts.topic);
  const goal = meta?.goal ?? "(unknown)";
  const systemFragment = renderSystemPrompt(opts.profile, opts.topic, goal);
  return `${systemFragment}\n\nYour assigned task:\n${opts.task}\n\nRemember: post your findings via the board tool (action=post, topic="${opts.topic}", author="${opts.profile.name}") before you finish.`;
}

export function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const prompt = buildPrompt(opts);
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const piBin = process.env.PI_BIN || "pi";

  appendEvent("spawn_start", { name: opts.profile.name, topic: opts.topic });

  return new Promise<SpawnResult>((resolve) => {
    // --print: 非交互脚本化驱动; --approve: 信任项目本地扩展（同一份 pi-harness + .pi-board/）
    const child = spawn(piBin, ["--print", "--approve", prompt], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Escalate if the process ignores SIGTERM
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > OUTPUT_TAIL_CHARS * 2) {
        output = output.slice(-OUTPUT_TAIL_CHARS);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      appendEvent("spawn_end", { name: opts.profile.name, topic: opts.topic, exitCode, timedOut });
      resolve({
        name: opts.profile.name,
        exitCode,
        output: output.slice(-OUTPUT_TAIL_CHARS).trim(),
        timedOut,
      });
    };

    child.on("error", (err) => {
      output += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

export function spawnAgents(optsList: SpawnOptions[]): Promise<SpawnResult[]> {
  return Promise.all(optsList.map(spawnAgent));
}
