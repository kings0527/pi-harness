export const MAX_COMPLETION_RESERVE_TOKENS = 48_000;
export const MAX_INGRESS_RESERVE_TOKENS = 32_768;
export const PROVIDER_ESTIMATE_SAFETY_TOKENS = 16_384;

export interface ContextHeadroomInput {
  contextTokens: number | null | undefined;
  contextWindow: number;
  modelMaxOutputTokens?: number | null;
  observedMaxOutputTokens?: number | null;
  pendingInputTokens?: number;
}

export interface ContextHeadroomAssessment {
  contextTokens: number | null;
  contextWindow: number;
  outputReserveTokens: number;
  ingressReserveTokens: number;
  requiredHeadroomTokens: number;
  thresholdTokens: number;
  shouldCompact: boolean;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * Reserve room for both the provider's next completion and content arriving
 * between Pi's previous-usage check and the next request.
 */
export function assessContextHeadroom(input: ContextHeadroomInput): ContextHeadroomAssessment {
  const contextWindow = Math.max(0, Math.floor(input.contextWindow));
  const contextTokens = positiveInteger(input.contextTokens) ?? (input.contextTokens === 0 ? 0 : null);
  const observedOutput = positiveInteger(input.observedMaxOutputTokens);
  const modelBaseline = Math.min(
    positiveInteger(input.modelMaxOutputTokens) ?? MAX_COMPLETION_RESERVE_TOKENS,
    MAX_COMPLETION_RESERVE_TOKENS,
  );
  const configuredOutput = Math.max(modelBaseline, observedOutput ?? 0);
  const outputReserveTokens = Math.min(
    configuredOutput,
    Math.max(1, Math.floor(contextWindow * 0.25)),
  );
  const baselineIngress = Math.min(
    MAX_INGRESS_RESERVE_TOKENS,
    Math.max(256, Math.ceil(contextWindow * 0.04)),
  );
  const ingressReserveTokens = Math.min(
    Math.max(0, contextWindow - 1),
    baselineIngress + (positiveInteger(input.pendingInputTokens) ?? 0),
  );
  const requiredHeadroomTokens = Math.min(
    Math.max(0, contextWindow - 1),
    outputReserveTokens + ingressReserveTokens,
  );
  const thresholdTokens = Math.max(0, contextWindow - requiredHeadroomTokens);

  return {
    contextTokens,
    contextWindow,
    outputReserveTokens,
    ingressReserveTokens,
    requiredHeadroomTokens,
    thresholdTokens,
    shouldCompact: contextTokens !== null
      && contextWindow > 0
      && contextTokens >= thresholdTokens,
  };
}

interface OutputBudgetLocation {
  path: readonly string[];
  minimum: number;
}

// These are the payload shapes emitted by pi-ai's supported adapters.
const OUTPUT_BUDGET_LOCATIONS: readonly OutputBudgetLocation[] = [
  { path: ["max_tokens"], minimum: 1 },
  { path: ["max_completion_tokens"], minimum: 1 },
  { path: ["max_output_tokens"], minimum: 16 },
  { path: ["maxTokens"], minimum: 1 },
  { path: ["maxOutputTokens"], minimum: 1 },
  { path: ["config", "maxOutputTokens"], minimum: 1 },
  { path: ["inferenceConfig", "maxTokens"], minimum: 1 },
  { path: ["options", "maxTokens"], minimum: 1 },
];

const THINKING_BUDGET_LOCATIONS: readonly (readonly string[])[] = [
  ["thinking", "budget_tokens"],
  ["additionalModelRequestFields", "thinking", "budget_tokens"],
];

export interface ProviderOutputClampResult {
  payload: unknown;
  changed: boolean;
  field?: string;
  requestedTokens?: number;
  allowedTokens?: number;
}

function childRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findOutputBudget(
  record: Record<string, unknown>,
): { location: OutputBudgetLocation; requestedTokens: number } | null {
  for (const location of OUTPUT_BUDGET_LOCATIONS) {
    let parent: Record<string, unknown> | null = record;
    for (const segment of location.path.slice(0, -1)) {
      parent = parent ? childRecord(parent[segment]) : null;
    }
    const requestedTokens = parent
      ? positiveInteger(parent[location.path.at(-1)!])
      : null;
    if (requestedTokens !== null) return { location, requestedTokens };
  }
  return null;
}

function findPositiveIntegerAt(
  record: Record<string, unknown>,
  paths: readonly (readonly string[])[],
): { path: readonly string[]; value: number } | null {
  for (const path of paths) {
    let parent: Record<string, unknown> | null = record;
    for (const segment of path.slice(0, -1)) {
      parent = parent ? childRecord(parent[segment]) : null;
    }
    const value = parent ? positiveInteger(parent[path.at(-1)!]) : null;
    if (value !== null) return { path, value };
  }
  return null;
}

function replaceOutputBudget(
  record: Record<string, unknown>,
  path: readonly string[],
  value: number,
): Record<string, unknown> {
  const result = { ...record };
  let source = record;
  let target = result;
  for (const segment of path.slice(0, -1)) {
    const sourceChild = childRecord(source[segment])!;
    const targetChild = { ...sourceChild };
    target[segment] = targetChild;
    source = sourceChild;
    target = targetChild;
  }
  target[path.at(-1)!] = value;
  return result;
}

/** Last-mile output-only clamp. Message and tool payloads are never rewritten. */
export function clampProviderOutputBudget(
  payload: unknown,
  usage: { contextTokens: number | null | undefined; contextWindow: number },
  safetyTokens = PROVIDER_ESTIMATE_SAFETY_TOKENS,
): ProviderOutputClampResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { payload, changed: false };
  }
  const record = payload as Record<string, unknown>;
  const outputBudget = findOutputBudget(record);
  if (!outputBudget) return { payload, changed: false };
  const { location, requestedTokens } = outputBudget;
  const thinkingBudget = findPositiveIntegerAt(record, THINKING_BUDGET_LOCATIONS);
  const field = location.path.join(".");
  const contextTokens = positiveInteger(usage.contextTokens) ?? (usage.contextTokens === 0 ? 0 : null);
  const contextWindow = positiveInteger(usage.contextWindow);
  if (contextTokens === null || contextWindow === null) {
    return { payload, changed: false, field, requestedTokens };
  }

  const scaledSafetyTokens = Math.min(
    Math.max(0, Math.floor(safetyTokens)),
    Math.max(0, Math.floor(contextWindow * 0.04)),
  );
  const providerMinimum = thinkingBudget
    ? Math.max(location.minimum, 2_048)
    : location.minimum;
  const allowedTokens = Math.max(
    providerMinimum,
    Math.floor(contextWindow - contextTokens - scaledSafetyTokens),
  );
  if (requestedTokens <= allowedTokens) {
    return { payload, changed: false, field, requestedTokens, allowedTokens };
  }

  let nextPayload = replaceOutputBudget(record, location.path, allowedTokens);
  if (thinkingBudget) {
    const allowedThinkingBudget = Math.max(1_024, allowedTokens - 1_024);
    if (thinkingBudget.value > allowedThinkingBudget) {
      nextPayload = replaceOutputBudget(
        nextPayload,
        thinkingBudget.path,
        allowedThinkingBudget,
      );
    }
  }

  return {
    payload: nextPayload,
    changed: true,
    field,
    requestedTokens,
    allowedTokens,
  };
}
