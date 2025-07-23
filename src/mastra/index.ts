import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { notesAgent } from './agents/notes-agent.js';
import { reorganizeWorkflow } from './workflows/reorganize-workflow.js';
import { readNotesAgent } from './agents/read-notes-agent.js';
import { tasksAgent } from './agents/tasks-agent.js';

// Explicitly register built-in note hooks
import { registerBeforeSaveHook } from './core/hooks/note-hooks.js';
import { registerAfterSaveHook } from './core/hooks/note-hooks.js';
import { rewriteNoteHook } from './core/hooks/builtin/rewrite-note-hook.js';
import { todoExtractHook } from './core/hooks/builtin/todo-extract-hook.js';
import { vectorEmbeddingHook } from './core/hooks/builtin/vector-embed-hook.js';

registerBeforeSaveHook(rewriteNoteHook);
registerBeforeSaveHook(todoExtractHook);
registerAfterSaveHook(vectorEmbeddingHook);

export const mastra = new Mastra({
  workflows: { reorganizeWorkflow },
  agents: { notesAgent, readNotesAgent, tasksAgent },
  storage: new LibSQLStore({
    url: ':memory:',
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
