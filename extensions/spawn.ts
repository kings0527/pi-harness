import { Type } from "typebox";
// 注意：extension 中引用 core/ 时使用相对路径
import { listProfiles, loadProfile } from "../core/identity/index.ts";
import { spawnAgent, spawnAgents } from "../core/spawn/index.ts";
import type { SpawnOptions } from "../core/spawn/index.ts";
import { hasArchivedTopic, listTopics, openTopic, postNote } from "../core/board/index.ts";
import { getStormConfig } from "../core/storm/index.ts";
import {
  getFluxConfig,
  isFluxDisabled,
  pickStartingLenses,
  resolveFluxModels,
} from "../core/flux/index.ts";
import {
  artifactsDir,
  buildCollectiveBoardSummary,
  closeField,
  getFieldMeta,
  listPresences,
  listResources,
  openField,
  readPulses,
  resolveFieldStorageRoot,
  type FieldMode,
  type TentacleOutcome,
} from "../core/field/index.ts";
import {
  createTentacleWorktree,
  inspectWorktreeChanges,
  removeTentacleWorktree,
  type TentacleWorktree,
} from "../core/field/worktree.ts";
import { assessContextSize } from "../core/context-size/index.ts";
import { appendEvent } from "../core/events/index.ts";

function warnIfLargeResult(text: string, ctx: any, action: string): void {
  const contextWindow = ctx?.model?.contextWindow ?? ctx?.getContextUsage?.()?.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
  const assessment = assessContextSize(text, contextWindow);
  if (!assessment.shouldWarn) return;

  const message = `Full spawn ${action} output preserved: ~${assessment.estimatedTokens} tokens (${(assessment.ratio * 100).toFixed(1)}% of ${contextWindow}). Review agent output and Board notes for duplication or excessive verbosity.`;
  console.error(`[spawn] WARN: ${message}`);
  try {
    appendEvent("hook_warn", { rule: "spawn-output-size", action, ...assessment, message });
  } catch {
    // Warning persistence must not alter the tool result.
  }
}

export default async function(pi: any) {
  pi.registerTool({
    name: "spawn",
    label: "Spawn Subagents",
    description: "Spawn Board collaborators. Actions: list, run, debate, flux.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("run"),
        Type.Literal("debate"),
        Type.Literal("flux"),
      ]),
      topic: Type.Optional(Type.String({ description: "Open Board topic" })),
      agents: Type.Optional(Type.Array(Type.Object({
        profile: Type.String({ description: "Agent profile" }),
        task: Type.String({ description: "Concrete task" }),
      }), { description: "Parallel agents" })),
      question: Type.Optional(Type.String({ description: "Debate/exploration question" })),
      angles: Type.Optional(Type.Array(Type.String(), { description: "Initial hints" })),
      lenses: Type.Optional(Type.Array(Type.String(), { description: "Starting lenses" })),
      models: Type.Optional(Type.Array(Type.String())),
      mode: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")])),
      tentacles: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Hard cap ms" })),
    }),
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      try {
        switch (params.action) {
          case "list": {
            const profiles = listProfiles();
            if (profiles.length === 0) {
              return { content: [{ type: "text" as const, text: "No agent profiles found in agents/." }] };
            }
            const formatted = profiles.map(p =>
              `- ${p.name}: specialty [${p.specialty.join(", ")}]; out_of_scope [${p.out_of_scope.join(", ")}]${p.confidence_bias ? `; bias: ${p.confidence_bias}` : ""}`
            ).join("\n");
            return { content: [{ type: "text" as const, text: formatted }] };
          }
          case "run": {
            if (!params.topic) throw new Error("topic is required for run");
            if (!params.agents?.length) throw new Error("agents is required for run");

            const topics = listTopics();
            const meta = topics.find((t: any) => t.id === params.topic);
            if (!meta) throw new Error(`Topic "${params.topic}" not found — open it with the board tool first`);
            if (meta.status !== "open") throw new Error(`Topic "${params.topic}" is ${meta.status}, not open`);

            const optsList: SpawnOptions[] = params.agents.map((a: any) => ({
              profile: loadProfile(a.profile),
              topic: params.topic,
              task: a.task,
              cwd: process.cwd(),
              ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
            }));

            const names = optsList.map(o => o.profile.name).join(", ");
            onUpdate?.({ content: [{ type: "text" as const, text: `Spawning ${optsList.length} subagent(s) in parallel: ${names} ...` }] });

            const results = await spawnAgents(optsList);

            const formatted = results.map(r => {
              const status = r.timedOut ? "TIMED OUT" : `exit ${r.exitCode}`;
              return `## ${r.name} (${status})\n${r.output || "(no output)"}`;
            }).join("\n\n");
            const resultText = `${formatted}\n\n---\nNow \`board read ${params.topic}\` to check convergence — if gaps remain, spawn another round.`;
            warnIfLargeResult(resultText, ctx, "run");
            return { content: [{ type: "text" as const, text: resultText }] };
          }
          case "debate": {
            if (!params.topic) throw new Error("topic is required for debate");
            if (!params.question) throw new Error("question is required for debate");

            const storm = getStormConfig();
            if (!storm.enabled) throw new Error("Storm mode is disabled. Enable it with /storm on <model1>,<model2>");
            if (storm.models.length < 2) throw new Error("Storm requires at least 2 models. Configure with /storm on <model1>,<model2>");

            const debateTopics = listTopics();
            const debateMeta = debateTopics.find((t: any) => t.id === params.topic);
            if (!debateMeta) throw new Error(`Topic "${params.topic}" not found — open it with the board tool first`);
            if (debateMeta.status !== "open") throw new Error(`Topic "${params.topic}" is ${debateMeta.status}, not open`);

            const models = storm.models;
            const participants: SpawnOptions[] = [];

            if (models.length === 2) {
              const advocateProfile = loadProfile("advocate");
              const criticProfile = loadProfile("critic");
              participants.push({
                profile: advocateProfile,
                topic: params.topic,
                task: `DEBATE POSITION: Defend the following with evidence and rigorous argument:\n"${params.question}"\nYou MUST find the strongest possible case FOR this position.`,
                cwd: process.cwd(),
                model: models[0],
                ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
              });
              participants.push({
                profile: criticProfile,
                topic: params.topic,
                task: `DEBATE POSITION: Challenge and stress-test the following claim:\n"${params.question}"\nYou MUST find the strongest counterexamples and logical gaps AGAINST this position.\nREAD THE BOARD FIRST — the advocate has already posted their arguments. You MUST directly address their specific points.`,
                cwd: process.cwd(),
                model: models[1],
                ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
              });
            } else {
              for (let i = 0; i < models.length; i++) {
                participants.push({
                  profile: {
                    name: `analyst-${i + 1}`,
                    specialty: ["independent analysis", "evidence-based reasoning"],
                    confidence_bias: "form your own conclusion independently before reading others",
                    out_of_scope: ["agreeing without evidence", "repeating others without adding new insight"],
                    interactionMode: "debate" as const,
                  },
                  topic: params.topic,
                  task: `INDEPENDENT ANALYSIS: Analyze the following question from your own perspective with evidence and rigorous reasoning:\n"${params.question}"\nREAD THE BOARD FIRST — if others have already posted, you MUST address their points: agree with evidence or refute with counter-evidence. Add NEW insight, do not merely repeat.`,
                  cwd: process.cwd(),
                  model: models[i],
                  ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
                });
              }
            }

            const participantSummary = participants.map((p, i) => `${p.profile.name} (${models[i]})`).join(", ");
            onUpdate?.({ content: [{ type: "text" as const, text: `⚡ Storm debate: ${participants.length} participants [${participantSummary}] on: "${params.question}"` }] });

            const debateResults = [];
            for (let i = 0; i < participants.length; i++) {
              const result = await spawnAgent(participants[i]);
              debateResults.push(result);
              if (i < participants.length - 1) {
                onUpdate?.({ content: [{ type: "text" as const, text: `${result.name} finished (exit ${result.exitCode}). Spawning ${participants[i + 1].profile.name}...` }] });
              }
            }

            const debateFormatted = debateResults.map((r, i) => {
              const status = r.timedOut ? "TIMED OUT" : `exit ${r.exitCode}`;
              return `## ${r.name} [${models[i]}] (${status})\n${r.output || "(no output)"}`;
            }).join("\n\n");
            const debateText = `${debateFormatted}\n\n---\n⚡ Debate round complete (${debateResults.length} participants). Now \`board read ${params.topic}\` to synthesize all positions. Consider: where do they agree? Where is the evidence strongest? What remains unresolved?`;
            warnIfLargeResult(debateText, ctx, "debate");
            return { content: [{ type: "text" as const, text: debateText }] };
          }
          case "flux": {
            if (!params.question?.trim()) throw new Error("question is required for flux");

            const config = getFluxConfig();
            if (isFluxDisabled(config)) {
              throw new Error("Flux mode is disabled. Re-enable with /flux on");
            }

            const activeModelId = String(ctx?.model?.id ?? "").trim();
            const activeProvider = String(ctx?.model?.provider ?? "").trim();
            const currentModelSpec = activeModelId
              ? (activeProvider ? `${activeProvider}/${activeModelId}` : activeModelId)
              : undefined;
            const models = resolveFluxModels(config, currentModelSpec, params.models);

            const sessionId = ctx?.sessionManager?.getSessionId?.();
            const topicId = String(params.topic ?? "").trim() || `flux-${Date.now()}`;
            const pTopics = listTopics();
            const pMeta = pTopics.find((t: any) => t.id === topicId);
            if (!pMeta) {
              if (hasArchivedTopic(topicId)) {
                throw new Error(`Topic "${topicId}" already exists in archive; pick a fresh topic ID`);
              }
              openTopic(topicId, params.question.trim(), {
                ...(typeof sessionId === "string" && sessionId.trim()
                  ? { actor: { id: sessionId } }
                  : {}),
              });
            } else if (pMeta.status !== "open") {
              throw new Error(`Topic "${topicId}" is ${pMeta.status}, not open`);
            }

            const mode: FieldMode = params.mode ?? config.mode ?? "shared";
            const requestedCount = params.tentacles
              ?? (Array.isArray(params.lenses) && params.lenses.length > 0 ? params.lenses.length : undefined)
              ?? (Array.isArray(params.angles) && params.angles.length > 0 ? params.angles.length : undefined)
              ?? config.tentacles
              ?? Math.max(models.length, 3);
            const tentacleCount = Math.min(Math.max(1, requestedCount), 8);
            const lenses = pickStartingLenses(tentacleCount, params.lenses);

            const rootCwd = ctx?.cwd ?? process.cwd();
            const fieldStorageRoot = resolveFieldStorageRoot();
            const fieldId = `${topicId}--field-${Date.now()}`;
            openField(fieldId, params.question, {
              topic: topicId,
              mode,
              rootCwd,
              createdBy: "flux-coordinator",
              storageRoot: fieldStorageRoot,
            });
            const sharedArtifacts = artifactsDir(fieldId, fieldStorageRoot);

            const createdWorktrees: TentacleWorktree[] = [];
            const participants: SpawnOptions[] = [];
            const tentacleMeta: Array<{
              label: string;
              lens: string;
              model?: string;
              worktree?: TentacleWorktree;
            }> = [];

            try {
              for (let i = 0; i < tentacleCount; i++) {
                const lens = lenses[i];
                const label = `t${i + 1}-${lens.id}`;
                const actorId = `${fieldId}:${label}`;
                const model = models.length > 0 ? models[i % models.length] : undefined;
                const angleHint = params.angles?.[i]?.trim();

                let tentacleCwd = rootCwd;
                let wt: TentacleWorktree | undefined;
                if (mode === "worktree") {
                  wt = createTentacleWorktree(rootCwd, fieldId, label, fieldStorageRoot);
                  createdWorktrees.push(wt);
                  tentacleCwd = wt.path;
                }

                const taskLines = [
                  `Question / Objective: "${params.question}"`,
                  `Starting lens (${lens.name}): ${lens.startingBias}`,
                  ...(angleHint ? [`Initial direction hint: ${angleHint}`] : []),
                  ...(wt
                    ? [`Workspace topology: isolated git worktree (${wt.path}) sharing the live cognitive field with peers.`]
                    : [`Workspace topology: shared workspace (${rootCwd}). Use field action=claim/release before mutating exclusive shared resources.`]),
                  `Stay in the environment feedback loop until you hit a verified breakthrough (emit kind="breach"), exhaust live leads across angles, or hit a concrete external block.`,
                ];

                participants.push({
                  profile: loadProfile("tentacle"),
                  topic: topicId,
                  task: taskLines.join("\n"),
                  cwd: tentacleCwd,
                  ...(model ? { model } : {}),
                  label,
                  fieldId,
                  actorId,
                  fieldStorageRoot,
                  lens: lens.id,
                  lensGuidance: lens.startingBias,
                  artifactsPath: sharedArtifacts,
                  ...(signal ? { signal } : {}),
                  env: {
                    PI_FIELD_ID: fieldId,
                    PI_FIELD_ROOT: fieldStorageRoot,
                    PI_FIELD_ACTOR: label,
                    PI_FIELD_ACTOR_ID: actorId,
                    PI_FIELD_LENS: lens.id,
                  },
                  ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
                });
                tentacleMeta.push({ label, lens: lens.id, model, worktree: wt });
              }

              const lineup = tentacleMeta.map(t => `${t.label}[${t.model ?? "default"}]`).join(", ");
              onUpdate?.({
                content: [{
                  type: "text" as const,
                  text: `Live Flux field "${fieldId}" (${mode}): launching ${tentacleCount} concurrent tentacles [${lineup}]...`,
                }],
              });

              const poll = setInterval(() => {
                try {
                  const live = listPresences(fieldId, { storageRoot: fieldStorageRoot });
                  const pulses = readPulses(fieldId, undefined, fieldStorageRoot);
                  const locks = listResources(fieldId, fieldStorageRoot);
                  const meta = getFieldMeta(fieldId, fieldStorageRoot);
                  const lockInfo = locks.length ? ` | locks: ${locks.map(l => `${l.resource}(${l.holderLabel})`).join(",")}` : "";
                  const statusTag = meta?.status === "breached" ? " | BREACH!" : "";
                  onUpdate?.({
                    content: [{
                      type: "text" as const,
                      text: `Live field "${fieldId}": ${live.length} active | ${pulses.length} pulses${lockInfo}${statusTag}`,
                    }],
                  });
                } catch {
                  /* telemetry is best-effort */
                }
              }, 2500);
              poll.unref?.();

              let results;
              try {
                results = await spawnAgents(participants);
              } finally {
                clearInterval(poll);
              }

              const outcomes: TentacleOutcome[] = results.map((r, i) => {
                const tm = tentacleMeta[i];
                let worktreePath: string | undefined;
                let worktreeDiffStat: string | undefined;
                if (tm.worktree) {
                  const diff = inspectWorktreeChanges(tm.worktree.path);
                  if (diff.dirty) {
                    worktreePath = tm.worktree.path;
                    worktreeDiffStat = diff.summary;
                  } else {
                    removeTentacleWorktree(rootCwd, tm.worktree.path);
                  }
                }
                return {
                  label: tm.label,
                  lens: tm.lens,
                  model: tm.model,
                  exitCode: r.exitCode,
                  timedOut: r.timedOut,
                  output: r.output,
                  ...(worktreePath ? { worktreePath, worktreeDiffStat } : {}),
                };
              });

              const finalMeta = getFieldMeta(fieldId, fieldStorageRoot);
              const breached = Boolean(finalMeta?.breachSeq || finalMeta?.status === "breached");
              closeField(fieldId, {
                status: breached ? "breached" : "closed",
                storageRoot: fieldStorageRoot,
              });

              const summary = buildCollectiveBoardSummary(fieldId, outcomes, fieldStorageRoot);
              postNote(topicId, "flux", summary, {
                tags: ["flux-synthesis"],
                ...(typeof sessionId === "string" && sessionId.trim()
                  ? { actor: { id: sessionId }, kind: "evidence" as const }
                  : {}),
              });

              const pulseCount = readPulses(fieldId, undefined, fieldStorageRoot).length;
              const statusNote = breached
                ? `BREACH verified by ${finalMeta?.breachedBy ?? "tentacle"} (pulse #${finalMeta?.breachSeq ?? "?"})`
                : "natural saturation";
              const responseText = `Live Flux complete (${tentacleCount} tentacles, ${mode}, ${pulseCount} pulses, ${statusNote}).\nSingle-point structured digest posted to topic "${topicId}".\n\n${summary}\n\n---\nReview the collective echoes above, then verify/converge on "${topicId}" (or launch another targeted probe).`;
              warnIfLargeResult(responseText, ctx, "flux");
              return { content: [{ type: "text" as const, text: responseText }] };
            } catch (err) {
              for (const wt of createdWorktrees) {
                removeTentacleWorktree(rootCwd, wt.path);
              }
              closeField(fieldId, { storageRoot: fieldStorageRoot });
              throw err;
            }
          }
          default:
            throw new Error(`Unknown action: ${params.action}`);
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
      }
    }
  });
}
