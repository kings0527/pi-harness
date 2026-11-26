import {
  COGNITIVE_LENSES,
  clearProjectFluxConfig,
  getFluxConfig,
  getGlobalFluxPath,
  getProjectFluxPath,
  hasProjectFluxConfig,
  isFluxDisabled,
  resolveFluxModels,
  setFluxConfig,
  type FluxConfig,
  type FluxConfigScope,
} from "../core/flux/index.ts";
import { listFields, type FieldMode } from "../core/field/index.ts";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export function formatModelSpec(model: Pick<ModelInfo, "provider" | "id">): string {
  const provider = String(model.provider ?? "").trim();
  const id = String(model.id ?? "").trim();
  return provider ? `${provider}/${id}` : id;
}

export function activeModelSpec(ctx: any): string | undefined {
  const id = String(ctx?.model?.id ?? "").trim();
  if (!id) return undefined;
  const provider = String(ctx?.model?.provider ?? "").trim();
  return provider ? `${provider}/${id}` : id;
}

/**
 * Resolve a user-typed model token against available provider/id catalog entries,
 * ALWAYS preserving the full `provider/id` channel identity.
 */
export function fuzzyMatchModel(
  query: string,
  available: ModelInfo[],
  preferredProvider?: string,
): ModelInfo | null {
  const lower = query.toLowerCase().trim();
  if (!lower) return null;

  const exactSpec = available.find((m) => formatModelSpec(m).toLowerCase() === lower);
  if (exactSpec) return exactSpec;

  const exactIds = available.filter((m) => m.id.toLowerCase() === lower);
  if (exactIds.length > 0) {
    if (preferredProvider) {
      const sameProvider = exactIds.find(
        (m) => m.provider.toLowerCase() === preferredProvider.toLowerCase(),
      );
      if (sameProvider) return sameProvider;
    }
    return exactIds[0];
  }

  const bySpec = available.find((m) => formatModelSpec(m).toLowerCase().includes(lower));
  if (bySpec) return bySpec;

  const byName = available.find((m) => m.name.toLowerCase().includes(lower));
  if (byName) return byName;

  const byProvider = available.find((m) => m.provider.toLowerCase().includes(lower));
  if (byProvider) return byProvider;

  return null;
}

function getAvailableModels(ctx: any): ModelInfo[] {
  try {
    if (!ctx?.modelRegistry?.getAvailable) return [];
    return ctx.modelRegistry.getAvailable().map((m: any) => ({
      id: String(m.id ?? ""),
      name: String(m.name ?? m.id ?? ""),
      provider: String(m.provider ?? ""),
    }));
  } catch {
    return [];
  }
}

function formatModelList(available: ModelInfo[], activeSpec?: string): string {
  const grouped: Record<string, ModelInfo[]> = {};
  for (const m of available) {
    const key = m.provider || "(default)";
    (grouped[key] ??= []).push(m);
  }
  const lines: string[] = [];
  for (const provider of Object.keys(grouped).sort()) {
    lines.push(`  [${provider}]`);
    for (const m of grouped[provider].sort((a, b) => a.id.localeCompare(b.id))) {
      const spec = formatModelSpec(m);
      const star = activeSpec && spec === activeSpec ? " * (current)" : "";
      lines.push(`    - ${spec}${star}`);
    }
  }
  return lines.join("\n");
}

function defaultWriteScope(): FluxConfigScope {
  return hasProjectFluxConfig() ? "project" : "global";
}

function formatStatus(config: FluxConfig, ctx: any): string {
  const activeSpec = activeModelSpec(ctx);
  const disabled = isFluxDisabled(config);
  const resolved = resolveFluxModels(config, activeSpec);
  const activeFields = listFields().filter((f) => f.status !== "closed");
  const fieldLine =
    activeFields.length > 0
      ? `\n   Active fields: ${activeFields.map((f) => `${f.id} (${f.status}/${f.mode})`).join(", ")}`
      : "";
  const lenses = COGNITIVE_LENSES.map((l) => l.id).join(", ");
  const scopeLabel =
    config.source === "project"
      ? `project (${getProjectFluxPath()})`
      : config.source === "global"
        ? `global (${getGlobalFluxPath()})`
        : "default (zero-config ON)";

  if (disabled) {
    return `Live Flux mode: OFF [${scopeLabel}]\n   Re-enable with: /flux on  (or /flux in TUI)`;
  }

  const poolLine =
    config.models.length > 0
      ? config.models.join(", ")
      : resolved.length > 0
        ? `auto -> ${resolved[0]} (current session model)`
        : "auto (pi default model)";

  return [
    `Live Flux mode: ON [${scopeLabel}]`,
    `   Models: ${poolLine}`,
    `   Tentacles: ${config.tentacles ?? "auto (3+)"}`,
    `   Topology: ${config.mode ?? "shared"} (shared workspace or worktree parallel clones + shared sideline)`,
    `   Starting lenses: ${lenses} (decaying initial bias)${fieldLine}`,
    `   Configure interactively: /flux (TUI spacebar picker) | /flux models`,
    `   Trigger directly in natural language or via: spawn action=flux, topic="<topic>", question="<q>"`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Zero-dependency TUI Spacebar Multi-Select Picker (auto-saves on every toggle)
// ---------------------------------------------------------------------------

export type PickerKey =
  | { kind: "up" | "down" | "pgup" | "pgdn" | "space" | "enter" | "escape" | "backspace" | "ctrl+c" }
  | { kind: "char"; ch: string }
  | { kind: "unknown" };

export function decodePickerKey(data: string): PickerKey {
  if (!data) return { kind: "unknown" };
  if (data === "\x03" || /^\x1b\[99;5u$/.test(data)) return { kind: "ctrl+c" };
  if (data === "\x1b[A" || data === "\x1bOA" || /^\x1b\[1;\d+A$/.test(data)) return { kind: "up" };
  if (data === "\x1b[B" || data === "\x1bOB" || /^\x1b\[1;\d+B$/.test(data)) return { kind: "down" };
  if (data === "\x1b[5~") return { kind: "pgup" };
  if (data === "\x1b[6~") return { kind: "pgdn" };
  if (data === " " || /^\x1b\[32(?:;\d+)?u$/.test(data)) return { kind: "space" };
  if (data === "\r" || data === "\n" || /^\x1b\[13(?:;\d+)?u$/.test(data)) return { kind: "enter" };
  if (data === "\x1b" || /^\x1b\[27(?:;\d+)?u$/.test(data)) return { kind: "escape" };
  if (data === "\x7f" || data === "\b" || /^\x1b\[127(?:;\d+)?u$/.test(data)) return { kind: "backspace" };

  const csiU = /^\x1b\[(\d+)(?:;1)?u$/.exec(data);
  if (csiU) {
    const code = Number(csiU[1]);
    if (code >= 33 && code <= 126) return { kind: "char", ch: String.fromCharCode(code) };
  }

  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 33 && code <= 126) return { kind: "char", ch: data };
  }
  return { kind: "unknown" };
}

function visibleCellWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff);
    w += isWide ? 2 : 1;
  }
  return w;
}

function clipPlain(text: string, maxCols: number): string {
  const limit = Math.max(4, maxCols);
  if (visibleCellWidth(text) <= limit) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = visibleCellWidth(ch);
    if (used + w > limit - 1) break;
    out += ch;
    used += w;
  }
  return out + "~";
}

interface PickerRow {
  spec: string;
  provider: string;
  id: string;
  name: string;
  isCurrent: boolean;
  isSavedOnly?: boolean;
}

const TENTACLE_CYCLE: Array<number | undefined> = [undefined, 2, 3, 4, 5, 6, 8];

async function openFluxPicker(ctx: any, initialScope?: FluxConfigScope): Promise<FluxConfig> {
  const available = getAvailableModels(ctx);
  const currentSpec = activeModelSpec(ctx);
  const currentProvider = String(ctx?.model?.provider ?? "").trim() || undefined;
  const initialConfig = getFluxConfig();

  const selected = new Set<string>();
  for (const saved of initialConfig.models) {
    if (saved.includes("/")) {
      selected.add(saved);
    } else {
      const matched = fuzzyMatchModel(saved, available, currentProvider);
      selected.add(matched ? formatModelSpec(matched) : saved);
    }
  }

  const knownSpecs = new Set<string>();
  const allRows: PickerRow[] = [];
  const sortedAvailable = [...available].sort((a, b) => {
    const specA = formatModelSpec(a);
    const specB = formatModelSpec(b);
    if (currentSpec && specA === currentSpec) return -1;
    if (currentSpec && specB === currentSpec) return 1;
    const pCmp = a.provider.localeCompare(b.provider);
    return pCmp !== 0 ? pCmp : a.id.localeCompare(b.id);
  });

  for (const m of sortedAvailable) {
    const spec = formatModelSpec(m);
    if (knownSpecs.has(spec)) continue;
    knownSpecs.add(spec);
    allRows.push({
      spec,
      provider: m.provider,
      id: m.id,
      name: m.name,
      isCurrent: Boolean(currentSpec && spec === currentSpec),
    });
  }
  for (const saved of selected) {
    if (knownSpecs.has(saved)) continue;
    knownSpecs.add(saved);
    const slash = saved.indexOf("/");
    allRows.push({
      spec: saved,
      provider: slash > 0 ? saved.slice(0, slash) : "(custom)",
      id: slash > 0 ? saved.slice(slash + 1) : saved,
      name: saved,
      isCurrent: Boolean(currentSpec && saved === currentSpec),
      isSavedOnly: true,
    });
  }

  let enabled = !isFluxDisabled(initialConfig);
  let tentacles: number | undefined = initialConfig.tentacles;
  let mode: FieldMode = initialConfig.mode ?? "shared";
  let scope: FluxConfigScope = initialScope ?? defaultWriteScope();
  let cursor = 0;
  let scrollOffset = 0;
  let filterText = "";
  let filtering = false;
  let statusLine = `Scope: ${scope} (auto-saves on every Space/toggle)`;

  const persistNow = (note: string) => {
    const orderedModels = allRows.map((r) => r.spec).filter((s) => selected.has(s));
    const nextCfg: FluxConfig = {
      enabled,
      models: orderedModels,
      ...(tentacles !== undefined ? { tentacles } : {}),
      mode,
    };
    setFluxConfig(nextCfg, scope);
    statusLine = `${note} -> auto-saved (${scope})`;
  };

  const visibleRows = (): PickerRow[] => {
    const q = filterText.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(
      (r) => r.spec.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
    );
  };

  const clampCursor = (rows: PickerRow[], maxVisible: number) => {
    if (rows.length === 0) {
      cursor = 0;
      scrollOffset = 0;
      return;
    }
    if (cursor < 0) cursor = 0;
    if (cursor >= rows.length) cursor = rows.length - 1;
    if (cursor < scrollOffset) scrollOffset = cursor;
    if (cursor >= scrollOffset + maxVisible) scrollOffset = cursor - maxVisible + 1;
    if (scrollOffset < 0) scrollOffset = 0;
  };

  const MAX_VISIBLE = 12;

  return ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (res: FluxConfig) => void) => {
      const fg = (token: string, text: string) =>
        typeof theme?.fg === "function" ? theme.fg(token, text) : text;
      const bold = (text: string) =>
        typeof theme?.bold === "function" ? theme.bold(text) : text;

      const finish = () => done(getFluxConfig());

      return {
        capturesViewportInput: true,
        invalidate() {},
        handleInput(data: string) {
          const key = decodePickerKey(data);
          const rows = visibleRows();

          if (filtering) {
            if (key.kind === "escape" || key.kind === "enter") {
              filtering = false;
              tui.requestRender();
              return;
            }
            if (key.kind === "ctrl+c") {
              finish();
              return;
            }
            if (key.kind === "backspace") {
              filterText = filterText.slice(0, -1);
              cursor = 0;
              scrollOffset = 0;
              tui.requestRender();
              return;
            }
            if (key.kind === "space") {
              filterText += " ";
              cursor = 0;
              scrollOffset = 0;
              tui.requestRender();
              return;
            }
            if (key.kind === "char") {
              filterText += key.ch;
              cursor = 0;
              scrollOffset = 0;
              tui.requestRender();
              return;
            }
            return;
          }

          if (key.kind === "escape" || key.kind === "enter" || key.kind === "ctrl+c") {
            finish();
            return;
          }
          if (key.kind === "char" && key.ch === "q") {
            finish();
            return;
          }
          if (key.kind === "up" || (key.kind === "char" && key.ch === "k")) {
            if (rows.length > 0) cursor = (cursor - 1 + rows.length) % rows.length;
            clampCursor(rows, MAX_VISIBLE);
            tui.requestRender();
            return;
          }
          if (key.kind === "down" || (key.kind === "char" && key.ch === "j")) {
            if (rows.length > 0) cursor = (cursor + 1) % rows.length;
            clampCursor(rows, MAX_VISIBLE);
            tui.requestRender();
            return;
          }
          if (key.kind === "pgup") {
            cursor = Math.max(0, cursor - 8);
            clampCursor(rows, MAX_VISIBLE);
            tui.requestRender();
            return;
          }
          if (key.kind === "pgdn") {
            cursor = Math.min(Math.max(0, rows.length - 1), cursor + 8);
            clampCursor(rows, MAX_VISIBLE);
            tui.requestRender();
            return;
          }
          if (key.kind === "space") {
            clampCursor(rows, MAX_VISIBLE);
            const row = rows[cursor];
            if (!row) return;
            if (selected.has(row.spec)) {
              selected.delete(row.spec);
              persistNow(`Removed ${row.spec}`);
            } else {
              selected.add(row.spec);
              enabled = true;
              persistNow(`Added ${row.spec}`);
            }
            tui.requestRender();
            return;
          }
          if (key.kind === "char" && key.ch === "/") {
            filtering = true;
            tui.requestRender();
            return;
          }
          if (key.kind === "char" && key.ch === "c") {
            selected.clear();
            enabled = true;
            persistNow("Pool cleared (auto-inherit current model)");
            tui.requestRender();
            return;
          }
          if (key.kind === "char" && key.ch === "t") {
            const idx = TENTACLE_CYCLE.indexOf(tentacles);
            tentacles = TENTACLE_CYCLE[(idx + 1) % TENTACLE_CYCLE.length];
            persistNow(`Tentacles: ${tentacles ?? "auto"}`);
            tui.requestRender();
            return;
          }
          if (key.kind === "char" && key.ch === "m") {
            mode = mode === "shared" ? "worktree" : "shared";
            persistNow(`Topology: ${mode}`);
            tui.requestRender();
            return;
          }
          if (key.kind === "char" && key.ch === "e") {
            enabled = !enabled;
            persistNow(`Flux: ${enabled ? "ON" : "OFF"}`);
            tui.requestRender();
            return;
          }
          if (key.kind === "char" && key.ch === "s") {
            if (scope === "project") {
              scope = "global";
              const removed = clearProjectFluxConfig();
              persistNow(removed ? "Switched to global (cleared project override)" : "Switched to global");
            } else {
              scope = "project";
              persistNow("Switched to project override");
            }
            tui.requestRender();
            return;
          }
        },
        render(width: number): string[] {
          const w = Math.max(36, width - 2);
          const rule = "-".repeat(Math.min(w, 78));
          const rows = visibleRows();
          clampCursor(rows, MAX_VISIBLE);

          const lines: string[] = [];
          const stateBadge = enabled ? fg("success", "ON") : fg("warning", "OFF");
          const poolCount =
            selected.size > 0
              ? `${selected.size} selected`
              : `auto (${currentSpec ?? "current model"})`;
          lines.push(fg("borderAccent", clipPlain(rule, w)));
          lines.push(bold(fg("accent", clipPlain("Live Flux Model Pool & Topology", w))));
          lines.push(
            `${stateBadge} | ${clipPlain(`pool: ${poolCount} | tentacles: ${tentacles ?? "auto"} | mode: ${mode} | scope: ${scope}`, Math.max(10, w - 6))}`,
          );

          if (filtering || filterText) {
            const filterPrompt = filtering
              ? `Filter (/): ${filterText}_   [Enter/Esc to stop filtering]`
              : `Filter: "${filterText}"   [press / to edit]`;
            lines.push(fg("accent", clipPlain(filterPrompt, w)));
          }
          lines.push(fg("borderMuted", clipPlain(rule, w)));

          if (rows.length === 0) {
            lines.push(
              fg(
                "muted",
                clipPlain(
                  allRows.length === 0
                    ? "No models found in registry (will auto-inherit current model)."
                    : `No models matching "${filterText}". Press / then Backspace to clear.`,
                  w,
                ),
              ),
            );
          } else {
            const slice = rows.slice(scrollOffset, scrollOffset + MAX_VISIBLE);
            if (scrollOffset > 0) {
              lines.push(fg("dim", clipPlain(`  ... ${scrollOffset} above ...`, w)));
            }
            for (let i = 0; i < slice.length; i += 1) {
              const row = slice[i];
              const idx = scrollOffset + i;
              const focused = idx === cursor;
              const checked = selected.has(row.spec);
              const pointer = focused ? ">" : " ";
              const box = checked ? "[x]" : "[ ]";
              const tags: string[] = [];
              if (row.isCurrent) tags.push("* current");
              if (row.isSavedOnly) tags.push("saved");
              const suffix = tags.length > 0 ? `  (${tags.join(", ")})` : "";
              const plain = clipPlain(`${pointer} ${box} ${row.spec}${suffix}`, w);
              if (focused) {
                lines.push(bold(fg("accent", plain)));
              } else if (checked) {
                lines.push(fg("success", plain));
              } else {
                lines.push(fg("text", plain));
              }
            }
            const remaining = rows.length - (scrollOffset + slice.length);
            if (remaining > 0) {
              lines.push(fg("dim", clipPlain(`  ... ${remaining} below ...`, w)));
            }
          }

          lines.push(fg("borderMuted", clipPlain(rule, w)));
          lines.push(
            fg(
              "muted",
              clipPlain(
                "Space: toggle+save | Up/Down/jk: move | /: filter | c: auto-current | t: tentacles | m: mode | e: on/off | s: scope | Enter/Esc/q: done",
                w,
              ),
            ),
          );
          lines.push(fg("dim", clipPlain(statusLine, w)));
          lines.push(fg("borderAccent", clipPlain(rule, w)));
          return lines;
        },
      };
    },
    { overlay: true },
  );
}

export default async function (pi: any) {
  pi.registerCommand("flux", {
    description:
      "Configure Live Flux collective intelligence. Usage: /flux (TUI spacebar picker) | status | models | on [models] | off | tentacles <N|auto> | mode shared|worktree | scope global|project",
    async handler(args: string, ctx: any) {
      const trimmed = args.trim();
      const lower = trimmed.toLowerCase();
      const canTui = ctx?.mode === "tui" && typeof ctx?.ui?.custom === "function";

      if (!trimmed) {
        if (canTui) {
          const finalCfg = await openFluxPicker(ctx);
          pi.sendMessage({
            customType: "flux-status",
            content: formatStatus(finalCfg, ctx),
            display: "block",
          });
          return;
        }
        pi.sendMessage({
          customType: "flux-status",
          content: formatStatus(getFluxConfig(), ctx),
          display: "block",
        });
        return;
      }

      if (lower === "status") {
        pi.sendMessage({
          customType: "flux-status",
          content: formatStatus(getFluxConfig(), ctx),
          display: "block",
        });
        return;
      }

      if (lower === "models" || lower === "ui" || lower === "pick") {
        if (canTui) {
          const finalCfg = await openFluxPicker(ctx);
          pi.sendMessage({
            customType: "flux-status",
            content: formatStatus(finalCfg, ctx),
            display: "block",
          });
          return;
        }
        const available = getAvailableModels(ctx);
        const content =
          available.length > 0
            ? `Available models (provider/id):\n${formatModelList(available, activeModelSpec(ctx))}\n\nSet pool with: /flux on <provider/id>[,<provider/id>]`
            : "Model registry unavailable in this mode.";
        pi.sendMessage({ customType: "flux-status", content, display: "block" });
        return;
      }

      if (lower.startsWith("scope")) {
        const target = trimmed.slice("scope".length).trim().toLowerCase();
        if (target !== "global" && target !== "project") {
          pi.sendMessage({
            customType: "flux-status",
            content: "Error: scope must be 'global' or 'project'.\nUsage: /flux scope global|project",
            display: "block",
          });
          return;
        }
        const current = getFluxConfig();
        if (target === "global") {
          setFluxConfig(current, "global");
          const cleared = clearProjectFluxConfig();
          pi.sendMessage({
            customType: "flux-status",
            content: `Saved Flux config globally (${getGlobalFluxPath()})${cleared ? " and removed project override" : ""}.`,
            display: "block",
          });
        } else {
          setFluxConfig(current, "project");
          pi.sendMessage({
            customType: "flux-status",
            content: `Saved project-local Flux override (${getProjectFluxPath()}).`,
            display: "block",
          });
        }
        return;
      }

      if (lower === "off") {
        const config = getFluxConfig();
        setFluxConfig({ ...config, enabled: false }, defaultWriteScope());
        pi.sendMessage({
          customType: "flux-status",
          content: "Flux mode explicitly disabled. Re-enable anytime with /flux on.",
          display: "block",
        });
        return;
      }

      if (lower.startsWith("tentacles")) {
        const nStr = trimmed.slice("tentacles".length).trim().toLowerCase();
        const config = getFluxConfig();
        if (nStr === "auto") {
          const { tentacles: _drop, ...rest } = config;
          setFluxConfig({ ...rest, enabled: true }, defaultWriteScope());
          pi.sendMessage({
            customType: "flux-status",
            content: "Tentacles reset to auto (3+ concurrent live agents).",
            display: "block",
          });
          return;
        }
        const n = parseInt(nStr, 10);
        if (isNaN(n) || n < 1 || n > 8) {
          pi.sendMessage({
            customType: "flux-status",
            content: "Error: tentacles must be 1-8 or 'auto'.\nUsage: /flux tentacles <N|auto>",
            display: "block",
          });
          return;
        }
        setFluxConfig({ ...config, enabled: true, tentacles: n }, defaultWriteScope());
        pi.sendMessage({
          customType: "flux-status",
          content: `Tentacles set to ${n} (${n} concurrent live agents sharing the sideline field).`,
          display: "block",
        });
        return;
      }

      if (lower.startsWith("mode")) {
        const mode = trimmed.slice("mode".length).trim().toLowerCase();
        if (mode !== "shared" && mode !== "worktree") {
          pi.sendMessage({
            customType: "flux-status",
            content: "Error: mode must be 'shared' or 'worktree'.\nUsage: /flux mode shared|worktree",
            display: "block",
          });
          return;
        }
        const config = getFluxConfig();
        setFluxConfig({ ...config, enabled: true, mode }, defaultWriteScope());
        const desc =
          mode === "worktree"
            ? "worktree (isolated git worktree per tentacle + shared live cognitive sideline)"
            : "shared (shared workspace + live sideline + cooperative resource claims)";
        pi.sendMessage({
          customType: "flux-status",
          content: `Flux topology set to ${desc}.`,
          display: "block",
        });
        return;
      }

      if (lower === "on" || lower.startsWith("on ")) {
        const modelsStr = trimmed.slice(2).trim();
        const available = getAvailableModels(ctx);
        const currentSpec = activeModelSpec(ctx);
        const currentProvider = String(ctx?.model?.provider ?? "").trim() || undefined;
        const config = getFluxConfig();
        const scope = defaultWriteScope();

        if (!modelsStr) {
          const nextModels =
            config.models.length > 0 ? config.models : currentSpec ? [currentSpec] : [];
          setFluxConfig({ ...config, enabled: true, models: nextModels }, scope);
          pi.sendMessage({
            customType: "flux-status",
            content: formatStatus(getFluxConfig(), ctx),
            display: "block",
          });
          return;
        }

        const requested = modelsStr
          .split(",")
          .map((m: string) => m.trim())
          .filter(Boolean);
        if (requested.length < 1) {
          pi.sendMessage({
            customType: "flux-status",
            content: "Provide at least 1 model.\nExample: /flux on deepseek/deepseek-flash",
            display: "block",
          });
          return;
        }

        if (available.length === 0) {
          setFluxConfig({ ...config, enabled: true, models: requested }, scope);
          pi.sendMessage({
            customType: "flux-status",
            content: `Live Flux enabled (${scope}).\n   Models: ${requested.join(", ")}\n   (Registry unavailable; stored verbatim)`,
            display: "block",
          });
          return;
        }

        const unmatched: string[] = [];
        const resolved: string[] = [];
        for (const token of requested) {
          const match = fuzzyMatchModel(token, available, currentProvider);
          if (match) {
            resolved.push(formatModelSpec(match));
          } else {
            unmatched.push(token);
          }
        }

        if (unmatched.length > 0) {
          pi.sendMessage({
            customType: "flux-status",
            content: `Cannot find models matching: ${unmatched.join(", ")}\n\nAvailable (provider/id):\n${formatModelList(available, currentSpec)}\n\nTip: run /flux in TUI to toggle models with Spacebar.`,
            display: "block",
          });
          return;
        }

        setFluxConfig({ ...config, enabled: true, models: resolved }, scope);
        const matchInfo = requested
          .map((s: string, i: number) => (s === resolved[i] ? resolved[i] : `${s} -> ${resolved[i]}`))
          .join(", ");
        pi.sendMessage({
          customType: "flux-status",
          content: `Live Flux enabled (${scope})!\n   Models: ${matchInfo}\n   Topology: ${config.mode ?? "shared"}`,
          display: "block",
        });
        return;
      }

      pi.sendMessage({
        customType: "flux-status",
        content:
          "Unknown flux command.\nUsage: /flux (TUI picker) | status | models | on [models] | off | tentacles <N|auto> | mode shared|worktree | scope global|project",
        display: "block",
      });
    },
    getArgumentCompletions(prefix: string) {
      const completions = ["status", "models", "on ", "off", "tentacles ", "mode ", "scope "];
      return completions
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ label: c.trim(), value: c }));
    },
  });
}
