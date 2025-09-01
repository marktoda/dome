import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { config } from '../../core/utils/config.js';
import { agentInstructions } from '../prompts/PromptRegistry.js';

export const tasksAgent = new Agent({
  name: 'Tasks Extraction Agent',
  instructions: agentInstructions.tasksAgent,
  model: openai(config.ai.models.tasksAgent),
  tools: {},
});
