import { getModelConfig, getDefaultModel } from './index.js';
import { BaseModelConfig } from './types.js';

export type TaskKind = 'retrieval_eval' | 'rerank' | 'generation' | 'tool_router' | 'rewrite';

export interface PickModelOpts {
  task: TaskKind;
  quality?: 'fast' | 'balanced' | 'high';
  explicitId?: string;
}

/**
 * Lightweight rule-based model chooser.  Central place to map tasks to model IDs.
 */
export function chooseModel({
  task,
  quality = 'balanced',
  explicitId,
}: PickModelOpts): BaseModelConfig {
  if (explicitId) return getModelConfig(explicitId);

  switch (task) {
    case 'retrieval_eval':
      return getModelConfig('gpt-4o');
    case 'rerank':
      return getModelConfig('@cf/baai/bge-reranker-base');
    case 'generation':
      return getModelConfig('gpt-4o');
    case 'rewrite':
      return getModelConfig('gpt-4o');
    case 'tool_router':
      return getModelConfig('gpt-4o');
    default:
      return getDefaultModel();
  }
}
