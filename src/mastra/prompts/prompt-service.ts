import {
  notePlaceForTopic,
  aiSearchNotes,
  autoCategorizeNote,
  rewriteNote,
  extractOpenTasks,
  updateTodoFile,
} from './templates.js';

export enum PromptName {
  NotePlaceForTopic = 'notePlaceForTopic',
  AiSearchNotes = 'aiSearchNotes',
  AutoCategorizeNote = 'autoCategorizeNote',
  RewriteNote = 'rewriteNote',
  ExtractOpenTasks = 'extractOpenTasks',
  UpdateTodoFile = 'updateTodoFile',
}

const templates = {
  [PromptName.NotePlaceForTopic]: notePlaceForTopic,
  [PromptName.AiSearchNotes]: aiSearchNotes,
  [PromptName.AutoCategorizeNote]: autoCategorizeNote,
  [PromptName.RewriteNote]: rewriteNote,
  [PromptName.ExtractOpenTasks]: extractOpenTasks,
  [PromptName.UpdateTodoFile]: updateTodoFile,
} as const;

type Templates = typeof templates;
type Params<T> = T extends (vars: infer P) => any ? P : never;

export type PromptVars<N extends PromptName> = Params<Templates[N]>;

export class PromptService {
  render<N extends PromptName>(name: N, vars: PromptVars<N>): string {
    const fn = templates[name] as (arg: PromptVars<N>) => string;
    return fn(vars);
  }
}

export const promptService = new PromptService(); 