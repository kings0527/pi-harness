import { spawn } from "node:child_process";
import { appendEvent } from "../events/index.ts";
import { listTopics } from "../board/index.ts";
import { latestFieldActivityMs } from "../field/index.ts";
import { renderSystemPrompt } from "../identity/index.ts";
import type { AgentProfile } from "../identity/index.ts";

export interface SpawnOptions {
  profile: AgentProfile;
  topic: string;
  task: string; // 分派给该 subagent 的具体调查任务
  cwd?: string;
  /** Optional hard wall-clock cap (enforced only when explicitly passed). */
  timeoutMs?: number;
  /** Activity watchdog idle threshold (ms since last output or Live Field heartbeat). Default: 10 min; <= 0 disables. */
  idleTimeoutMs?: number;
  /** Optional AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
  model?: string; // 指定模型（如 "deepseek/deepseek-flash" 或 "ollama/..."），传递 --model 给 pi
  env?: Record<string, string>;
  label?: string;
  fieldId?: string;
  actorId?: string;
  fieldStorageRoot?: string;
  lens?: string;
  lensGuidance?: string;
  artifactsPath?: string;
}

export interface SpawnResult {
  name: string;
  exitCode: number | null;
  output: string; // complete stdout + stderr (ADR-0012)
  timedOut: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function buildPrompt(opts: SpawnOptions): string {
  const topics = listTopics();
  const meta = topics.find(t => t.id === opts.topic);
  const goal = meta?.goal ?? "(unknown)";
  const systemFragment = renderSystemPrompt(opts.profile, opts.topic, goal, {
    fieldId: opts.fieldId,
    actorLabel: opts.label,
    lens: opts.lens,
    lensGuidance: opts.lensGuidance,
    artifactsPath: opts.artifactsPath,
  });
  if (opts.fieldId) {
    return `${systemFragment}\n\nYour mission:\n${opts.task}`;
  }
  return `${systemFragment}\n\nYour assigned task:\n${opts.task}\n\nRemember: post your findings via the board tool (action=post, topic="${opts.topic}", author="${opts.profile.name}") before you finish.`;
}

export function spawnAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const prompt = buildPrompt(opts);
  const cwd = opts.cwd ?? process.cwd();
  const hardTimeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : undefined;
  const idleTimeoutMs =
    typeof opts.idleTimeoutMs === "number" && Number.isFinite(opts.idleTimeoutMs)
      ? opts.idleTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS;
  const piBin = process.env.PI_BIN || "pi";
  const agentName = opts.label || opts.profile.name;

  appendEvent("spawn_start", {
    name: agentName,
    topic: opts.topic,
    ...(opts.fieldId ? { fieldId: opts.fieldId } : {}),
    ...(opts.lens ? { lens: opts.lens } : {}),
  });

  return new Promise<SpawnResult>((resolve) => {
    // --print: 非交互脚本化驱动; --approve: 信任项目本地扩展（同一份 pi-harness + .pi-board/）
    const args = ["--print", "--approve"];
    if (opts.model) {
      args.push("--model", opts.model);
    }
    args.push("--", prompt);
    const child = spawn(piBin, args, {
      cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    let settled = false;
    let killing = false;
    let lastActivityAt = Date.now();
    let escalateTimer: ReturnType<typeof setTimeout> | undefined;

    const terminateChild = (markTimedOut: boolean) => {
      if (killing || settled) return;
      killing = true;
      if (markTimedOut) timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* child already exited */
      }
      // Escalate if the process ignores SIGTERM
      escalateTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 5000);
      escalateTimer.unref?.();
    };

    const hardTimer = hardTimeoutMs
      ? setTimeout(() => terminateChild(true), hardTimeoutMs)
      : undefined;

    // Activity watchdog: active workers producing output or updating Live Field
    // heartbeats run as long as real progress continues; only silent hangs time out.
    let watchdogInterval: ReturnType<typeof setInterval> | undefined;
    if (idleTimeoutMs > 0) {
      const checkMs = Math.min(5000, Math.max(50, Math.floor(idleTimeoutMs / 4)));
      watchdogInterval = setInterval(() => {
        if (opts.fieldId) {
          const fieldActivity = latestFieldActivityMs(
            opts.fieldId,
            opts.actorId,
            opts.fieldStorageRoot,
          );
          if (fieldActivity > lastActivityAt) {
            lastActivityAt = fieldActivity;
          }
        }
        if (Date.now() - lastActivityAt >= idleTimeoutMs) {
          terminateChild(true);
        }
      }, checkMs);
      watchdogInterval.unref?.();
    }

    const onAbort = () => terminateChild(false);
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const collect = (chunk: Buffer) => {
      lastActivityAt = Date.now();
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (watchdogInterval) clearInterval(watchdogInterval);
      if (escalateTimer) clearTimeout(escalateTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      appendEvent("spawn_end", {
        name: agentName,
        topic: opts.topic,
        ...(opts.fieldId ? { fieldId: opts.fieldId } : {}),
        exitCode,
        timedOut,
      });
      resolve({
        name: agentName,
        exitCode,
        output: output.trim(),
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
