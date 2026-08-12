export const CONTEXT_WARN_RATIO = 0.2;

export interface ContextSizeAssessment {
  bytes: number;
  estimatedTokens: number;
  contextWindow: number;
  ratio: number;
  shouldWarn: boolean;
}

/** Conservative, model-agnostic estimate for mixed English/CJK project text. */
export function estimateContextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf-8") / 3);
}

export function assessContextSize(
  text: string,
  contextWindow: number,
  warnRatio: number = CONTEXT_WARN_RATIO,
): ContextSizeAssessment {
  const bytes = Buffer.byteLength(text, "utf-8");
  const estimatedTokens = estimateContextTokens(text);
  const ratio = contextWindow > 0 ? estimatedTokens / contextWindow : 0;
  return {
    bytes,
    estimatedTokens,
    contextWindow,
    ratio,
    shouldWarn: contextWindow > 0 && ratio >= warnRatio,
  };
}
