/**
 * Watcher-specific configuration wrapper.
 * Provides backward compatibility while using centralized configuration.
 */

import { config } from '../core/utils/config.js';

export interface WatcherConfig {
  vaultPath: string;
  stateDir: string;
  processors: {
    todos: boolean;
    embeddings: boolean;
    index: boolean;
  };
  debounce: {
    fileChangeMs: number;
    awaitWriteFinish: boolean;
  };
  ignore: string[];
}

/**
 * Get watcher configuration from centralized config
 * @returns {WatcherConfig} Watcher-specific configuration
 */
export function getWatcherConfig(): WatcherConfig {
  // Default ignore patterns plus any custom ones from environment
  const defaultIgnore = [
    '**/.git/**',
    '**/.dome/**',
    '**/node_modules/**',
    '**/.DS_Store',
    '**/todo.md',
    '**/.index.json',
    '**/INDEX.md',
    '**/*.tmp',
    '**/*~',
    '**/.#*',
  ];
  
  const customIgnore = config.watcherIgnore || [];
  
  return {
    vaultPath: config.paths.vault,
    stateDir: config.paths.state,
    processors: {
      todos: config.features.todos,
      embeddings: config.features.embeddings,
      index: config.features.index,
    },
    debounce: {
      fileChangeMs: config.debounce?.fileChangeMs || 300,
      awaitWriteFinish: (config.debounce?.awaitWriteFinish?.stabilityThreshold || 2000) > 0,
    },
    ignore: [...defaultIgnore, ...customIgnore],
  };
}