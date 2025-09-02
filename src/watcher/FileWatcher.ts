import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { config } from '../core/utils/config.js';
import logger from '../core/utils/logger.js';
import { FileEvent, FileEventType } from './types.js';

// Re-export for backward compatibility
export { FileEvent, FileEventType } from './types.js';

export interface WatcherOptions {
  vaultPath?: string;
  ignored?: (string | RegExp)[];
  debounceMs?: number;
  awaitWriteFinish?: boolean;
  ignoreInitial?: boolean;
  depth?: number;
}

export class FileWatcher extends EventEmitter {
  private watcher?: FSWatcher;
  private readonly vaultPath: string;
  private readonly ignored: (string | RegExp)[];
  private readonly debounceMs: number;
  private readonly awaitWriteFinish: boolean;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly ignoreInitial: boolean;
  private readonly depth: number;

  constructor(options: WatcherOptions = {}) {
    super();
    this.vaultPath = options.vaultPath || config.DOME_VAULT_PATH;
    this.debounceMs = options.debounceMs ?? 500;
    this.awaitWriteFinish = options.awaitWriteFinish ?? true;
    this.ignoreInitial = options.ignoreInitial ?? true;
    this.depth = options.depth ?? 10;

    this.ignored = [
      '**/.git/**',
      '**/.dome/**',
      '**/node_modules/**',
      '**/.DS_Store',
      /todo\.md$/,      // Use regex for todo.md files
      /\.index\.json$/, // Use regex for .index.json files
      /INDEX\.md$/,     // Use regex for INDEX.md files
      ...(options.ignored || []),
    ];
  }

  async start(): Promise<void> {
    if (this.watcher) {
      logger.warn('Watcher already running');
      return;
    }

    logger.info(`Starting file watcher on ${this.vaultPath}`);
    logger.debug(`Ignoring patterns: ${this.ignored.join(', ')}`);

    this.watcher = watch(this.vaultPath, {
      ignored: this.ignored,
      persistent: true,
      ignoreInitial: this.ignoreInitial,
      awaitWriteFinish: this.awaitWriteFinish
        ? { stabilityThreshold: 300, pollInterval: 100 }
        : false,
      depth: this.depth,
      followSymlinks: false,
    });

    this.watcher
      .on('add', p => this.handleRaw(p, FileEventType.Added))
      .on('change', p => this.handleRaw(p, FileEventType.Changed))
      .on('unlink', p => this.handleRaw(p, FileEventType.Deleted))
      .on('error', err => logger.error(`Watcher error: ${err}`))
      .on('ready', () => logger.info('File watcher ready'));
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;

    logger.info('Stopping file watcher');

    // Clear pending debounce timers
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();

    await this.watcher.close();
    this.watcher = undefined;
  }

  private handleRaw(filePath: string, type: FileEventType): void {
    if (!filePath.endsWith('.md')) return;

    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      const relativePath = path.relative(this.vaultPath, filePath);
      const event: FileEvent = { type, path: filePath, relativePath };
      this.emit('file', event);
      logger.debug(`File ${type}: ${relativePath}`);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  isWatching(): boolean {
    return this.watcher !== undefined;
  }
}