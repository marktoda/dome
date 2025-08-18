import { config as appConfig } from '../core/utils/config.js';
import path from 'node:path';

export interface WatcherConfig {
  vaultPath: string;
  stateDir: string;
  processors: {
    todos: boolean;
    embeddings: boolean;
  };
  debounce: {
    fileChangeMs: number;
    awaitWriteFinish: boolean;
  };
  ignore: string[];
}

export function getWatcherConfig(): WatcherConfig {
  const vaultPath = appConfig.DOME_VAULT_PATH;
  const stateDir = path.join(vaultPath, '.dome');

  return {
    vaultPath,
    stateDir,
    processors: {
      todos: process.env.DOME_DISABLE_TODOS !== 'true',
      embeddings: process.env.DOME_DISABLE_EMBEDDINGS !== 'true',
    },
    debounce: {
      fileChangeMs: parseInt(process.env.DOME_WATCHER_DEBOUNCE || '500', 10),
      awaitWriteFinish: process.env.DOME_WATCHER_AWAIT_WRITE !== 'false',
    },
    ignore: [
      '**/.git/**',
      '**/.dome/**',
      '**/node_modules/**',
      '**/.DS_Store',
      '**/todo.md',
      '**/*.tmp',
      '**/*~',
      '**/.#*',
    ],
  };
}
