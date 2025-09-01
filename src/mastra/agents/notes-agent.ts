import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { getNotesTools } from '../tools/notes-tool.js';
import { config } from '../../core/utils/config.js';
import { agentInstructions } from '../prompts/PromptRegistry.js';

export const notesAgent = new Agent({
  name: 'Notes Agent',
  instructions: agentInstructions.notesAgent,
  model: openai(config.ai.models.notesAgent),
  tools: { ...getNotesTools() },
});
