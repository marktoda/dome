import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { getVaultContextTool, getNoteTool, searchNotesTool } from '../tools/notes-tool.js';

export const readNotesAgent = new Agent({
  name: 'Read-Only Notes Agent',
  instructions: `
    You are a *read-only* notes assistant.
    You may:
      – List all notes and their metadata
      – Retrieve and display specific notes
      – Search notes semantically
    The following tools are available to you:
      • getVaultContextTool – list all note metadata and structure
      • getNoteTool – read a single note
      • searchNotesTool – semantic search across notes
    Always cite note paths and avoid hallucinating content.
  `,
  model: openai('gpt-4.1-mini'),
  tools: { getVaultContextTool, getNoteTool, searchNotesTool },
});
