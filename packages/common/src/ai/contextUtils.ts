import { BaseModelConfig, calculateContextLimits } from './index.js';

export function allocateContext(
  model: BaseModelConfig,
  opts: { promptPct?: number; minResponse?: number } = {},
) {
  const limits = calculateContextLimits(model);
  const promptTokens = Math.floor(limits.maxContextTokens * (opts.promptPct ?? 0.6));

  // Cap the response length to the model\'s documented defaultMaxTokens or a safe ceiling.
  const responseCap = model.defaultMaxTokens ?? limits.maxResponseTokens;

  const maxResponse = Math.min(
    limits.maxResponseTokens,
    responseCap,
    limits.maxContextTokens - promptTokens,
  );

  // Ensure we satisfy a minimum response requirement when specified
  const finalMaxResponse = opts.minResponse ? Math.max(maxResponse, opts.minResponse) : maxResponse;
  return { promptTokens, maxResponse: finalMaxResponse };
}
