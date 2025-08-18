import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { config } from '../core/utils/config.js';
import logger from '../core/utils/logger.js';

export enum FileEventType {
  Added = 'added',
  Changed = 'changed',
  Deleted = 'deleted',
}

export interface FileEvent {
  type: FileEventType;
  path: string;
  relativePath: string;
}

export interface WatcherOptions {
  vaultPath?: string;
  ignored?: string[];
  debounceMs?: number;
  awaitWriteFinish?: boolean;
}

export class FileWatcher extends EventEmitter {
  private watcher?: FSWatcher;
  private readonly vaultPath: string;
  private readonly ignored: string[];
  private readonly debounceMs: number;
  private readonly awaitWriteFinish: boolean;
  private readonly processingFiles = new Set<string>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: WatcherOptions = {}) {
    super();
    this.vaultPath = options.vaultPath || config.DOME_VAULT_PATH;
    this.debounceMs = options.debounceMs ?? 500;
    this.awaitWriteFinish = options.awaitWriteFinish ?? true;

    // Default ignore patterns
    this.ignored = [
      '**/.git/**',
      '**/.dome/**',
      '**/node_modules/**',
      '**/.DS_Store',
      '**/todo.md', // Prevent loops from our own todo file
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
      ignoreInitial: true, // Don't process existing files on startup
      awaitWriteFinish: this.awaitWriteFinish
        ? {
            stabilityThreshold: 300,
            pollInterval: 100,
          }
        : false,
      depth: 10, // Watch nested directories
      followSymlinks: false,
    });

    this.watcher
      .on('add', filePath => this.handleFileEvent(filePath, FileEventType.Added))
      .on('change', filePath => this.handleFileEvent(filePath, FileEventType.Changed))
      .on('unlink', filePath => this.handleFileEvent(filePath, FileEventType.Deleted))
      .on('error', error => logger.error('Watcher error:', error))
      .on('ready', () => logger.info('File watcher ready'));
  }

  async stop(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    logger.info('Stopping file watcher');

    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Wait for any in-flight processing
    while (this.processingFiles.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    await this.watcher.close();
    this.watcher = undefined;
  }

  private handleFileEvent(filePath: string, type: FileEventType): void {
    // Only process markdown files
    if (!filePath.endsWith('.md')) {
      return;
    }

    // Clear existing timer for this file
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounced timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.emitFileEvent(filePath, type);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  private emitFileEvent(filePath: string, type: FileEventType): void {
    // Skip if already processing this file
    if (this.processingFiles.has(filePath)) {
      logger.debug(`Skipping ${filePath} - already processing`);
      return;
    }

    const relativePath = path.relative(this.vaultPath, filePath);

    const event: FileEvent = {
      type,
      path: filePath,
      relativePath,
    };

    logger.debug(`File ${type}: ${relativePath}`);

    this.processingFiles.add(filePath);
    this.emit('file', event);

    // Remove from processing set after a reasonable timeout
    setTimeout(() => {
      this.processingFiles.delete(filePath);
    }, 30000); // 30 second max processing time
  }

  isWatching(): boolean {
    return this.watcher !== undefined;
  }
}
