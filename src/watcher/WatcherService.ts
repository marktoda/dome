import path from 'node:path';
import logger from '../core/utils/logger.js';

import { FileWatcher } from './FileWatcher.js';
import { FileStateStore } from './FileStateStore.js';
import { KeyedQueue } from './KeyedQueue.js';
import { coalesceFileEvents } from './coalesce.js';
import { FileEvent, FileEventType } from './types.js';

import { FileProcessor } from '../core/processors/FileProcessor.js';
import { TodoProcessor } from '../core/processors/TodoProcessor.js';
import { EmbeddingProcessor } from '../core/processors/EmbeddingProcessor.js';
import { IndexProcessor } from '../core/processors/IndexProcessor.js';
import { getWatcherConfig, WatcherConfig } from './config.js';

interface ProcessorConfig {
  todos?: boolean;
  embeddings?: boolean;
  index?: boolean;
}

export class WatcherService {
  private readonly watcher: FileWatcher;
  private readonly processors: FileProcessor[] = [];
  private readonly state: FileStateStore;
  private readonly config: WatcherConfig;

  private saveInterval?: NodeJS.Timeout;

  private readonly queue = new KeyedQueue<string, FileEvent>(
    async (_key, event) => await this.processOne(event),
    // Coalesce events by relativePath
    (a, b) => coalesceFileEvents(a, b)
  );

  private shutdownRequested = false;

  constructor(processorConfig: ProcessorConfig = {}) {
    this.config = getWatcherConfig();
    const { todos = true, embeddings = true, index = true } = processorConfig;

    this.watcher = new FileWatcher({
      vaultPath: this.config.vaultPath,
      ignored: this.config.ignore,
      debounceMs: this.config.debounce.fileChangeMs,
      awaitWriteFinish: this.config.debounce.awaitWriteFinish,
      ignoreInitial: true,
    });

    const stateFile = path.join(this.config.stateDir, 'watcher-state.json');
    this.state = new FileStateStore(stateFile);

    if (todos) this.processors.push(new TodoProcessor());
    if (embeddings) this.processors.push(new EmbeddingProcessor());
    if (index) this.processors.push(new IndexProcessor());

    this.watcher.on('file', (e: FileEvent) => this.queue.add(e.relativePath, e));
  }

  async start(): Promise<void> {
    logger.info('Starting watcher service');
    await this.state.load();
    this.registerShutdownHandlers();
    await this.watcher.start();

    logger.info(`Watcher service started with ${this.processors.length} processor(s)`);
    this.processors.forEach(p => logger.info(`  - ${p.name}`));
  }

  async stop(): Promise<void> {
    logger.info('Stopping watcher service');
    this.shutdownRequested = true;

    await this.watcher.stop();
    await this.queue.onIdle();

    await this.state.save();

    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = undefined;
    }

    logger.info('Watcher service stopped');
  }

  private async processOne(event: FileEvent): Promise<void> {
    try {
      if (event.type === FileEventType.Deleted) {
        // Let processors react to deletions; then clear state
        await this.runProcessors(event);
        this.state.delete(event.relativePath);
        return;
      }

      // Only compute hash once; also avoid reading twice.
      const hash = await this.state.computeHash(event.path);
      const prev = this.state.get(event.relativePath);

      if (prev && prev.hash === hash) {
        logger.debug(`Skipping unchanged file: ${event.relativePath}`);
        return;
      }

      await this.runProcessors(event);

      this.state.upsert(event.relativePath, hash);
    } catch (err) {
      logger.error(`Error processing ${event.relativePath}:`, err);
    }
  }

  private async runProcessors(event: FileEvent): Promise<void> {
    const results = await Promise.allSettled(
      this.processors.map(p => p.process(event))
    );

    results.forEach((r, i) => {
      const name = this.processors[i].name;
      if (r.status === 'fulfilled') {
        const { success, processorName, duration, error } = r.value;
        if (success) {
          logger.debug(`✓ ${processorName ?? name} completed in ${duration}ms`);
        } else {
          logger.error(`✗ ${processorName ?? name} failed:`, error);
        }
      } else {
        logger.error(`Processor ${name} crashed:`, r.reason);
      }
    });
  }

  private registerShutdownHandlers(): void {
    const shutdown = async () => {
      if (!this.shutdownRequested) {
        logger.info('Received shutdown signal');
        await this.stop();
        process.exit(0);
      }
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Periodic save (every 5 minutes), cleared on stop()
    this.saveInterval = setInterval(() => {
      if (!this.shutdownRequested) {
        this.state.save().catch(err =>
          logger.error('Failed to save state during periodic save:', err)
        );
      }
    }, 5 * 60 * 1000);
  }
}