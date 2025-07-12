
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { notesAgent } from './agents/notes-agent.js';
import { reorganizeWorkflow } from './workflows/reorganize-workflow.js';

export const mastra = new Mastra({
  workflows: { reorganizeWorkflow },
  agents: { notesAgent },
  storage: new LibSQLStore({
    url: ":memory:",
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
