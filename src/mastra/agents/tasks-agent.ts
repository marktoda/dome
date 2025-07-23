import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';

export const tasksAgent = new Agent({
  name: 'Tasks Extraction Agent',
  instructions: `ROLE\nYou are **Tasks Extraction Agent**. Your sole purpose is to read a single Markdown note and identify all OPEN (not completed) action items / TODOs. Return them as JSON.\n\nRULES\n• Only include tasks that are NOT done.\n• Accept diverse author formatting – GitHub task lists, bullet items, standalone TODO: lines.\n• Never hallucinate tasks; extract exactly what is written.\n• Respond with strict JSON following the provided schema.`,
  // Use a tiny fast model – enough for extraction work
  model: openai('gpt-4o-mini'),
  tools: {},
}); 