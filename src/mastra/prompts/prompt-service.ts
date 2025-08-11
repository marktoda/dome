import {
  notePlaceForTopic,
  aiSearchNotes,
  autoCategorizeNote,
  rewriteNote,
  extractOpenTasks,
  updateTodoFile,
  updateTodoLists,
} from './templates.js';
import os from 'node:os';


export enum PromptName {
  NotePlaceForTopic = 'notePlaceForTopic',
  AiSearchNotes = 'aiSearchNotes',
  AutoCategorizeNote = 'autoCategorizeNote',
  RewriteNote = 'rewriteNote',
  ExtractOpenTasks = 'extractOpenTasks',
  UpdateTodoFile = 'updateTodoFile',
  UpdateTodoLists = 'updateTodoLists',
}

const templates = {
  [PromptName.NotePlaceForTopic]: notePlaceForTopic,
  [PromptName.AiSearchNotes]: aiSearchNotes,
  [PromptName.AutoCategorizeNote]: autoCategorizeNote,
  [PromptName.RewriteNote]: rewriteNote,
  [PromptName.ExtractOpenTasks]: extractOpenTasks,
  [PromptName.UpdateTodoFile]: updateTodoFile,
  [PromptName.UpdateTodoLists]: updateTodoLists,
} as const;

type Templates = typeof templates;
type Params<T> = T extends (vars: infer P) => any ? P : never;

export type PromptVars<N extends PromptName> = Params<Templates[N]>;

export class PromptService {
  render<N extends PromptName>(name: N, vars: PromptVars<N>): string {
    const fn = templates[name] as (arg: PromptVars<N>) => string;
    const situationalContext = buildSituationalContext();
    const promptBody = fn(vars);
    return `${situationalContext}\n\n${promptBody}`;
  }
}

export const promptService = new PromptService();

/**
 * Build a high-level situational context block that is prepended to every agent prompt.
 * Includes current timestamp, timezone, and a best-effort username. This helps the
 * language model stay aware of "when" and "who" is making the request without
 * polluting individual prompt templates.
 */
function buildSituationalContext(): string {
  const now = new Date();
  const iso = now.toISOString();
  let user = process.env['USER'] || process.env['USERNAME'] || '';

  // Fallback to OS user if env vars are not set
  if (!user) {
    try {
      user = os.userInfo().username;
    } catch {
      user = 'unknown';
    }
  }

  // Attempt to include the IANA timezone if available
  let tz = 'UTC';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
  } catch {
    /* continue with default */
  }

  return `SITUATIONAL CONTEXT\n• DateTime: ${iso} (${tz})\n• User: ${user}`;
} 