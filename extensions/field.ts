import { Type } from "typebox";
import {
  artifactsDir,
  buildFieldSnapshot,
  buildSidelineDelta,
  claimResource,
  closeField,
  emptySidelineCursor,
  extractToolTrace,
  getFieldMeta,
  listFields,
  listPresences,
  listResources,
  markPresenceDone,
  openField,
  postPulse,
  PULSE_KINDS,
  readPulses,
  releaseAllResources,
  releaseResource,
  updatePresence,
  type FieldMode,
  type PulseKind,
  type SidelineCursor,
} from "../core/field/index.ts";
import { FLUX_DISCIPLINE } from "../core/identity/index.ts";

interface FieldSessionState {
  actorId: string;
  actorLabel: string;
  fieldId: string | null;
  storageRoot?: string;
  lens?: string;
  cursor: SidelineCursor;
  snapshotInjectedForField: string | null;
}

const sessionStates = new Map<string, FieldSessionState>();

function resolveSessionId(ctx: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.trim().length > 0) return id;
  } catch {
    /* fallback below */
  }
  return process.env.PI_SESSION_ID || `pid-${process.pid}`;
}

function defaultActorLabel(actorId: string): string {
  if (process.env.PI_FIELD_ACTOR?.trim()) return process.env.PI_FIELD_ACTOR.trim();
  const short = actorId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8) || String(process.pid);
  return `agent-${short}`;
}

function stateFor(ctx: any): FieldSessionState {
  const sid = resolveSessionId(ctx);
  let state = sessionStates.get(sid);
  if (!state) {
    const envFieldId = process.env.PI_FIELD_ID?.trim() || null;
    const envStorageRoot = process.env.PI_FIELD_ROOT?.trim() || undefined;
    const envLens = process.env.PI_FIELD_LENS?.trim() || undefined;
    const actorId = process.env.PI_FIELD_ACTOR_ID?.trim() || sid;
    state = {
      actorId,
      actorLabel: defaultActorLabel(actorId),
      fieldId: envFieldId,
      storageRoot: envStorageRoot,
      lens: envLens,
      cursor: emptySidelineCursor(),
      snapshotInjectedForField: null,
    };
    sessionStates.set(sid, state);
  }
  return state;
}

function attachField(
  state: FieldSessionState,
  fieldId: string,
  options: { lens?: string; label?: string; storageRoot?: string } = {},
): void {
  state.fieldId = fieldId;
  if (options.storageRoot !== undefined) state.storageRoot = options.storageRoot;
  if (options.lens !== undefined) state.lens = options.lens;
  if (options.label !== undefined) state.actorLabel = options.label;
  state.cursor = emptySidelineCursor();
  state.snapshotInjectedForField = null;
}

function detachField(state: FieldSessionState): void {
  if (!state.fieldId) return;
  releaseAllResources(state.fieldId, state.actorId, state.storageRoot);
  markPresenceDone(state.fieldId, state.actorId, "done", state.storageRoot);
  state.fieldId = null;
  state.cursor = emptySidelineCursor();
  state.snapshotInjectedForField = null;
}

function activeFieldMeta(state: FieldSessionState) {
  if (!state.fieldId) return null;
  const meta = getFieldMeta(state.fieldId, state.storageRoot);
  if (!meta || meta.status === "closed") return null;
  return meta;
}

function liveFieldSystemFragment(state: FieldSessionState, goal: string, rootCwd: string): string {
  const artDir = artifactsDir(state.fieldId!, state.storageRoot);
  const isSpawnedTentacle = Boolean(process.env.PI_FIELD_ACTOR?.trim());
  const lines = [
    `# Live Sideline Field (${state.fieldId})`,
    `Identity: ${state.actorLabel}${state.lens ? ` | Starting lens (decaying bias): ${state.lens}` : ""}`,
    `Goal: ${goal}`,
    `Shared artifacts dir: ${artDir} | Root workspace: ${rootCwd}`,
    `Sideline deltas ([FIELD Δ]) arrive automatically at the tail of tool results whenever peers emit new objective pulses, claim/release exclusive resources, shift focus area, or touch the same target.`,
    ...(isSpawnedTentacle
      ? [
          `BOUNDARY (overrides generic Board workflow for this run): You are a spawned Live Field tentacle. Communicate via the \`field\` tool (pulses, resource claims, shared artifacts). Do NOT post/converge/close on the main \`board\`, do NOT \`distill\` to \`knowledge\`, and do NOT call \`field action=close\` — the coordinator performs single-point consolidation into Board once tentacles finish.`,
        ]
      : []),
    FLUX_DISCIPLINE,
  ];
  return lines.join("\n");
}

export default async function fieldExtension(pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const state = stateFor(ctx);
    const meta = activeFieldMeta(state);
    if (meta && state.fieldId) {
      try {
        updatePresence(
          state.fieldId,
          {
            actorId: state.actorId,
            label: state.actorLabel,
            lens: state.lens,
            cwd: ctx?.cwd ?? process.cwd(),
            heading: state.lens ? `starting (${state.lens})` : "joined field",
            status: "active",
          },
          state.storageRoot,
        );
      } catch {
        /* non-fatal startup presence */
      }
    }
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const state = stateFor(ctx);
    const meta = activeFieldMeta(state);
    if (!meta || !state.fieldId) return;

    const fragment = liveFieldSystemFragment(state, meta.goal, meta.rootCwd);
    const systemPrompt = event?.systemPrompt
      ? `${event.systemPrompt}\n\n${fragment}`
      : fragment;

    if (state.snapshotInjectedForField === state.fieldId) {
      return { systemPrompt };
    }

    const existingPulses = readPulses(state.fieldId, undefined, state.storageRoot);
    const resources = listResources(state.fieldId, state.storageRoot);
    state.cursor = {
      lastPulseSeq: existingPulses.at(-1)?.seq ?? 0,
      lastResourcesSig: resources.map((r) => `${r.resource}=${r.holderId}:${r.purpose}`).join("|"),
      lastPeersSig: "",
      lastOverlapSig: "",
      seenBreachSeqs: existingPulses.filter((p) => p.kind === "breach").map((p) => p.seq),
    };
    state.snapshotInjectedForField = state.fieldId;

    const snapshot = buildFieldSnapshot(state.fieldId, {
      selfActorId: state.actorId,
      storageRoot: state.storageRoot,
    });

    return {
      systemPrompt,
      message: {
        customType: "pi-harness-field-snapshot",
        content: snapshot,
        display: false,
        details: {
          fieldId: state.fieldId,
          actorId: state.actorId,
          lastPulseSeq: state.cursor.lastPulseSeq,
        },
      },
    };
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const state = stateFor(ctx);
    const meta = activeFieldMeta(state);
    if (!meta || !state.fieldId) return;
    try {
      const toolName = String(event?.toolName ?? event?.tool ?? "");
      const input = (event?.input ?? event?.args ?? {}) as Record<string, unknown>;
      const trace = extractToolTrace(toolName, input, ctx?.cwd ?? meta.rootCwd);
      updatePresence(
        state.fieldId,
        {
          actorId: state.actorId,
          label: state.actorLabel,
          lens: state.lens,
          cwd: ctx?.cwd ?? process.cwd(),
          heading: trace.heading,
          focusArea: trace.focusArea,
          targets: trace.targets,
          lastTool: toolName,
          status: "active",
        },
        state.storageRoot,
      );
    } catch {
      /* implicit trail must never fail tool execution */
    }
  });

  // Core sideline piggyback: deliver step-level incremental peer echoes, locks,
  // overlap notices, and breach waves at the tail of tool_result without
  // invalidating earlier prompt KV cache prefixes.
  pi.on("tool_result", async (event: any, ctx: any) => {
    const state = stateFor(ctx);
    const meta = activeFieldMeta(state);
    if (!meta || !state.fieldId) return;
    try {
      const toolName = String(event?.toolName ?? event?.tool ?? "");
      const input = (event?.input ?? event?.args ?? {}) as Record<string, unknown>;
      const trace = extractToolTrace(toolName, input, ctx?.cwd ?? meta.rootCwd);

      updatePresence(
        state.fieldId,
        {
          actorId: state.actorId,
          label: state.actorLabel,
          lens: state.lens,
          cwd: ctx?.cwd ?? process.cwd(),
          heading: trace.heading,
          focusArea: trace.focusArea,
          targets: trace.targets,
          lastTool: toolName,
          lastToolError: event?.isError === true,
          incrementStep: true,
          status: "active",
        },
        state.storageRoot,
      );

      // Avoid echoing a delta back onto field peek (already returned full state).
      if (toolName === "field" && input.action === "peek") return;

      const delta = buildSidelineDelta(state.fieldId, state.actorId, state.cursor, {
        currentTargets: trace.targets,
        storageRoot: state.storageRoot,
      });
      if (!delta) return;

      state.cursor = delta.nextCursor;
      if (delta.hasBreach) {
        console.error(
          `[field] BREACH WAVE delivered to ${state.actorLabel} on field="${state.fieldId}" (#${delta.breachPulses.map((p) => p.seq).join(",#")})`,
        );
      }

      const content = Array.isArray(event?.content) ? event.content : [];
      return {
        content: [
          ...content,
          { type: "text" as const, text: `\n\n${delta.text}` },
        ],
        ...(event?.structuredContent !== undefined
          ? { structuredContent: event.structuredContent }
          : {}),
      };
    } catch {
      /* sideline observation must never break a real tool result */
      return;
    }
  });

  pi.on("agent_end", async (_event: any, ctx: any) => {
    const state = stateFor(ctx);
    if (!state.fieldId) return;
    const isPrint = ctx?.mode === "print";
    if (isPrint) {
      releaseAllResources(state.fieldId, state.actorId, state.storageRoot);
      markPresenceDone(state.fieldId, state.actorId, "done", state.storageRoot);
    } else {
      markPresenceDone(state.fieldId, state.actorId, "idle", state.storageRoot);
    }
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    const sid = resolveSessionId(ctx);
    const state = sessionStates.get(sid);
    if (state) {
      detachField(state);
      sessionStates.delete(sid);
    }
  });

  // Minimal-friction tool: single tool with action dispatch.
  pi.registerTool({
    name: "field",
    label: "Live Sideline Field",
    description: "Fast shared sideline for parallel exploration: pulse, claim, release, peek, artifact, open, join, close, list.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("pulse"),
        Type.Literal("claim"),
        Type.Literal("release"),
        Type.Literal("peek"),
        Type.Literal("artifact"),
        Type.Literal("open"),
        Type.Literal("join"),
        Type.Literal("close"),
        Type.Literal("list"),
      ]),
      field: Type.Optional(Type.String({ description: "Field ID (defaults to attached field)" })),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("echo"),
          Type.Literal("need"),
          Type.Literal("conflict"),
          Type.Literal("breach"),
          Type.Literal("artifact"),
        ]),
      ),
      fact: Type.Optional(Type.String({ description: "1-3 lines of objective world feedback (method -> echo); no scores" })),
      anchor: Type.Optional(Type.String({ description: "Exact coordinate (file:line, address, cmd, artifact path)" })),
      next: Type.Optional(Type.String({ description: "Your next heading" })),
      resource: Type.Optional(Type.String({ description: "Exclusive resource key to coordinate" })),
      purpose: Type.Optional(Type.String({ description: "Why you are holding the exclusive resource" })),
      goal: Type.Optional(Type.String({ description: "open: exploration objective" })),
      mode: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")])),
      lens: Type.Optional(Type.String({ description: "join: optional starting cognitive lens" })),
    }),
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const state = stateFor(ctx);
      const targetField = String(params.field ?? state.fieldId ?? "").trim();

      switch (params.action) {
        case "list": {
          const all = listFields(state.storageRoot);
          if (all.length === 0) {
            return { content: [{ type: "text" as const, text: "No live fields yet." }] };
          }
          const rows = all.map(
            (f) => `- ${f.id} [${f.status}; ${f.mode}]${state.fieldId === f.id ? " (attached)" : ""} — ${f.goal}`,
          );
          return { content: [{ type: "text" as const, text: rows.join("\n") }] };
        }
        case "open": {
          if (!targetField) throw new Error("field ID is required for open");
          if (!params.goal?.trim()) throw new Error("goal is required for open");
          const meta = openField(targetField, params.goal, {
            mode: params.mode as FieldMode | undefined,
            createdBy: state.actorLabel,
            rootCwd: ctx?.cwd ?? process.cwd(),
            storageRoot: state.storageRoot,
          });
          attachField(state, meta.id, { lens: params.lens });
          updatePresence(
            meta.id,
            {
              actorId: state.actorId,
              label: state.actorLabel,
              lens: state.lens,
              cwd: ctx?.cwd ?? process.cwd(),
              heading: "opened field",
              status: "active",
            },
            state.storageRoot,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Opened and joined live field "${meta.id}" (${meta.mode}). Artifacts dir: ${artifactsDir(meta.id, state.storageRoot)}`,
              },
            ],
          };
        }
        case "join": {
          if (!targetField) throw new Error("field ID is required for join");
          const meta = getFieldMeta(targetField, state.storageRoot);
          if (!meta) throw new Error(`Field "${targetField}" not found`);
          attachField(state, meta.id, { lens: params.lens });
          updatePresence(
            meta.id,
            {
              actorId: state.actorId,
              label: state.actorLabel,
              lens: state.lens,
              cwd: ctx?.cwd ?? process.cwd(),
              heading: "joined field",
              status: "active",
            },
            state.storageRoot,
          );
          const snap = buildFieldSnapshot(meta.id, {
            selfActorId: state.actorId,
            storageRoot: state.storageRoot,
          });
          return { content: [{ type: "text" as const, text: snap }] };
        }
        case "close": {
          if (!targetField) throw new Error("field ID is required for close");
          const activePeers = listPresences(targetField, { storageRoot: state.storageRoot }).filter(
            (p) => p.actorId !== state.actorId,
          );
          if (activePeers.length > 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Cannot close field "${targetField}" while ${activePeers.length} peer(s) are still active (${activePeers.map((p) => p.label).join(", ")}). Emit a pulse or finish cleanly; the coordinator closes the field once all tentacles settle.`,
                },
              ],
            };
          }
          const closed = closeField(targetField, { storageRoot: state.storageRoot });
          if (state.fieldId === targetField) detachField(state);
          return {
            content: [
              {
                type: "text" as const,
                text: closed
                  ? `Closed field "${targetField}".`
                  : `Field "${targetField}" not found.`,
              },
            ],
          };
        }
        case "peek": {
          if (!targetField) throw new Error("No field attached; pass field=<id> or join one first");
          const snap = buildFieldSnapshot(targetField, {
            selfActorId: state.actorId,
            storageRoot: state.storageRoot,
          });
          const latest = readPulses(targetField, undefined, state.storageRoot);
          state.cursor.lastPulseSeq = latest.at(-1)?.seq ?? state.cursor.lastPulseSeq;
          return { content: [{ type: "text" as const, text: snap }] };
        }
        case "artifact": {
          if (!targetField) throw new Error("No field attached; pass field=<id>");
          const dir = artifactsDir(targetField, state.storageRoot);
          return {
            content: [
              {
                type: "text" as const,
                text: `Shared artifacts dir for "${targetField}": ${dir}\nWrite dumps/traces/scripts here, then announce via field action=pulse kind=artifact anchor="<file>" fact="<what it contains>".`,
              },
            ],
          };
        }
        case "claim": {
          if (!targetField) throw new Error("No field attached; pass field=<id>");
          if (!params.resource?.trim()) throw new Error("resource is required for claim");
          const result = claimResource(
            targetField,
            params.resource,
            {
              actorId: state.actorId,
              label: state.actorLabel,
              purpose: params.purpose || "exclusive access",
            },
            state.storageRoot,
          );
          if (result.acquired) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Claimed exclusive resource "${result.lease.resource}" for ${state.actorLabel} (${result.lease.purpose}). Release when done with field action=release.`,
                },
              ],
            };
          }
          const age = Math.max(0, Math.round((Date.now() - result.lease.acquiredAt) / 1000));
          return {
            content: [
              {
                type: "text" as const,
                text: `Resource "${result.lease.resource}" is BUSY — held by ${result.lease.holderLabel} (${result.lease.purpose}, ${age}s ago). Do NOT race it: work on non-exclusive analysis, inspect ${artifactsDir(targetField, state.storageRoot)}, or emit field action=pulse kind=need to piggyback a probe.`,
              },
            ],
          };
        }
        case "release": {
          if (!targetField) throw new Error("No field attached; pass field=<id>");
          if (!params.resource?.trim()) {
            const released = releaseAllResources(targetField, state.actorId, state.storageRoot);
            return {
              content: [
                {
                  type: "text" as const,
                  text: released.length
                    ? `Released resources: ${released.join(", ")}.`
                    : "No held resources to release.",
                },
              ],
            };
          }
          const ok = releaseResource(targetField, params.resource, state.actorId, state.storageRoot);
          return {
            content: [
              {
                type: "text" as const,
                text: ok
                  ? `Released "${params.resource}".`
                  : `Could not release "${params.resource}" (not held by you or already free).`,
              },
            ],
          };
        }
        case "pulse": {
          if (!targetField) throw new Error("No field attached; pass field=<id> or open/join one first");
          if (!params.fact?.trim()) throw new Error("fact is required for pulse");
          const kind = (params.kind ?? "echo") as PulseKind;
          if (!PULSE_KINDS.includes(kind)) {
            throw new Error(`Invalid pulse kind "${kind}"`);
          }
          // Auto-open if a standalone session pulses into a named field not yet created.
          if (!getFieldMeta(targetField, state.storageRoot)) {
            openField(targetField, params.fact.slice(0, 160), {
              createdBy: state.actorLabel,
              rootCwd: ctx?.cwd ?? process.cwd(),
              storageRoot: state.storageRoot,
            });
          }
          const pulse = postPulse(
            targetField,
            {
              actorId: state.actorId,
              actorLabel: state.actorLabel,
              lens: state.lens,
              kind,
              fact: params.fact,
              anchor: params.anchor,
              next: params.next,
            },
            state.storageRoot,
          );
          if (state.fieldId === targetField) {
            state.cursor.lastPulseSeq = Math.max(state.cursor.lastPulseSeq, pulse.seq);
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Emitted pulse #${pulse.seq} [${pulse.kind}] to field "${targetField}".`,
              },
            ],
          };
        }
        default:
          throw new Error(`Unknown field action "${params.action}"`);
      }
    },
  });

  pi.registerCommand("field", {
    description: "Join or inspect a live sideline field. Usage: /field open <id> <goal> | join <id> [lens] | leave | status | list | close [id]",
    async handler(args: string, ctx: any) {
      const state = stateFor(ctx);
      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const sub = parts[0] || "status";

      if (sub === "status") {
        if (!state.fieldId) {
          const active = listFields(state.storageRoot).filter((f) => f.status !== "closed");
          const hint = active.length
            ? `\nActive fields in workspace:\n${active.map((f) => `  - ${f.id} [${f.status}; ${f.mode}] — ${f.goal}`).join("\n")}\nJoin one with: /field join <id> [lens]`
            : "\nNo active fields. Open one with: /field open <id> <goal>";
          pi.sendMessage({ customType: "field-status", content: `Field: detached${hint}`, display: "block" });
          return;
        }
        pi.sendMessage({
          customType: "field-status",
          content: buildFieldSnapshot(state.fieldId, {
            selfActorId: state.actorId,
            storageRoot: state.storageRoot,
          }),
          display: "block",
        });
        return;
      }

      if (sub === "list") {
        const all = listFields(state.storageRoot);
        const text = all.length
          ? all.map((f) => `- ${f.id} [${f.status}; ${f.mode}]${state.fieldId === f.id ? " *" : ""} — ${f.goal}`).join("\n")
          : "No fields in this workspace.";
        pi.sendMessage({ customType: "field-status", content: text, display: "block" });
        return;
      }

      if (sub === "open") {
        const id = parts[1];
        const goal = parts.slice(2).join(" ").trim();
        if (!id || !goal) {
          pi.sendMessage({ customType: "field-status", content: "Usage: /field open <id> <goal>", display: "block" });
          return;
        }
        const meta = openField(id, goal, {
          createdBy: state.actorLabel,
          rootCwd: ctx?.cwd ?? process.cwd(),
          storageRoot: state.storageRoot,
        });
        attachField(state, meta.id);
        pi.sendMessage({
          customType: "field-status",
          content: `Opened & joined live field "${meta.id}" — ${meta.goal}\nOther terminals can join with: /field join ${meta.id} [spine|seam|probe|invert|scout]`,
          display: "block",
        });
        return;
      }

      if (sub === "join") {
        const id = parts[1];
        const lens = parts[2];
        if (!id) {
          pi.sendMessage({ customType: "field-status", content: "Usage: /field join <id> [lens]", display: "block" });
          return;
        }
        const meta = getFieldMeta(id, state.storageRoot);
        if (!meta) {
          pi.sendMessage({ customType: "field-status", content: `Field "${id}" not found.`, display: "block" });
          return;
        }
        attachField(state, meta.id, { lens });
        pi.sendMessage({
          customType: "field-status",
          content: `Joined live field "${meta.id}"${lens ? ` (lens=${lens})` : ""}.\n${buildFieldSnapshot(meta.id, { selfActorId: state.actorId, storageRoot: state.storageRoot })}`,
          display: "block",
        });
        return;
      }

      if (sub === "leave") {
        const prev = state.fieldId;
        detachField(state);
        pi.sendMessage({
          customType: "field-status",
          content: prev ? `Left field "${prev}" and released held resources.` : "Not attached to any field.",
          display: "block",
        });
        return;
      }

      if (sub === "close") {
        const id = parts[1] || state.fieldId;
        if (!id) {
          pi.sendMessage({ customType: "field-status", content: "Usage: /field close <id>", display: "block" });
          return;
        }
        closeField(id, { storageRoot: state.storageRoot });
        if (state.fieldId === id) detachField(state);
        pi.sendMessage({ customType: "field-status", content: `Closed field "${id}".`, display: "block" });
        return;
      }

      pi.sendMessage({
        customType: "field-status",
        content: "Usage: /field open <id> <goal> | join <id> [lens] | leave | status | list | close [id]",
        display: "block",
      });
    },
    getArgumentCompletions(prefix: string) {
      return ["open ", "join ", "leave", "status", "list", "close "]
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ label: c.trim(), value: c }));
    },
  });
}
