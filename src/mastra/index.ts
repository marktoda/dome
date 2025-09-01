import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { notesAgent } from './agents/notes-agent.js';
import { reorganizeWorkflow } from './workflows/reorganize-workflow.js';
import { parseTodosWorkflow } from './workflows/parse-todos-workflow.js';
import { readNotesAgent } from './agents/read-notes-agent.js';
import { tasksAgent } from './agents/tasks-agent.js';

export const mastra = new Mastra({
  workflows: { reorganizeWorkflow, parseTodosWorkflow },
  agents: { notesAgent, readNotesAgent, tasksAgent },
  storage: new LibSQLStore({
    url: ':memory:',
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
