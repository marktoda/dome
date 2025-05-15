import { AgentStateV3 as AgentState } from '../types/stateSlices';
import type { SliceUpdate } from '../types/stateSlices';
import { getLogger } from '@dome/common';

export type AnswerGuardUpdate = SliceUpdate<'metadata'>;

/**
 * answer_guard – simple placeholder that passes through for now.
 * In the future plug policy / moderation here.
 */
export const answerGuard = async (state: AgentState): Promise<AnswerGuardUpdate> => {
  const log = getLogger().child({ node: 'answerGuard' });
  log.info('Answer guard pass-through');
  return {
    metadata: {
      ...state.metadata,
      currentNode: 'answer_guard',
    },
  };
};
