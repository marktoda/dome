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
import { backlinkIndexHook } from './core/hooks/builtin/backlink-index-hook.js';
import { autoFilePlacementHook } from './core/hooks/builtin/auto-file-placement-hook.js';

// Ensure TODO extraction sees the original text before rewrite
registerBeforeSaveHook(todoExtractHook);
registerBeforeSaveHook(rewriteNoteHook);
registerAfterSaveHook(autoFilePlacementHook);
registerAfterSaveHook(vectorEmbeddingHook);
registerAfterSaveHook(backlinkIndexHook);

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
