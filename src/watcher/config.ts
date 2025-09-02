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
  ignore: (string | RegExp)[];
}

/**
 * Get watcher configuration from centralized config
 * @returns {WatcherConfig} Watcher-specific configuration
 */
export function getWatcherConfig(): WatcherConfig {
  // Default ignore patterns plus any custom ones from environment
  // Note: Using regex patterns for better matching with chokidar
  const defaultIgnore: (string | RegExp)[] = [
    '**/.git/**',
    '**/.dome/**',
    '**/node_modules/**',
    '**/.DS_Store',
    /todo\.md$/,       // Matches any todo.md file
    /\.index\.json$/,  // Matches any .index.json file  
    /INDEX\.md$/,      // Matches any INDEX.md file
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