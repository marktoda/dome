import { FileWatcher, FileEvent } from './FileWatcher.js';
import { FileProcessor, ProcessorResult } from '../core/processors/FileProcessor.js';
import { TodoProcessor } from '../core/processors/TodoProcessor.js';
import { EmbeddingProcessor } from '../core/processors/EmbeddingProcessor.js';
import logger from '../core/utils/logger.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWatcherConfig, WatcherConfig } from './config.js';

interface ProcessorConfig {
  todos?: boolean;
  embeddings?: boolean;
}

interface FileState {
  hash: string;
  lastProcessed: Date;
}

export class WatcherService {
  private watcher: FileWatcher;
  private processors: FileProcessor[] = [];
  private fileStates = new Map<string, FileState>();
  private stateFile: string;
  private isProcessing = false;
  private shutdownRequested = false;
  private config: WatcherConfig;

  constructor(processorConfig: ProcessorConfig = {}) {
    this.config = getWatcherConfig();
    const { todos = true, embeddings = true } = processorConfig;

    this.watcher = new FileWatcher({
      vaultPath: this.config.vaultPath,
      ignored: this.config.ignore,
      debounceMs: this.config.debounce.fileChangeMs,
      awaitWriteFinish: this.config.debounce.awaitWriteFinish,
    });
    this.stateFile = path.join(this.config.stateDir, 'watcher-state.json');

    // Initialize processors based on config
    if (todos) {
      this.processors.push(new TodoProcessor());
    }
    if (embeddings) {
      this.processors.push(new EmbeddingProcessor());
    }

    // Bind event handler
    this.watcher.on('file', this.handleFileEvent.bind(this));
  }

  async start(): Promise<void> {
    logger.info('Starting watcher service');

    // Load state from disk
    await this.loadState();

    // Register shutdown handlers
    this.registerShutdownHandlers();

    // Start watching
    await this.watcher.start();

    logger.info(`Watcher service started with ${this.processors.length} processor(s)`);
    this.processors.forEach(p => logger.info(`  - ${p.name}`));
  }

  async stop(): Promise<void> {
    logger.info('Stopping watcher service');
    this.shutdownRequested = true;

    // Stop accepting new events
    await this.watcher.stop();

    // Wait for current processing to complete
    while (this.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Save state to disk
    await this.saveState();

    logger.info('Watcher service stopped');
  }

  private async handleFileEvent(event: FileEvent): Promise<void> {
    if (this.shutdownRequested) {
      return;
    }

    this.isProcessing = true;

    try {
      // Check if file has changed since last processing
      if (await this.shouldSkipFile(event)) {
        logger.debug(`Skipping unchanged file: ${event.relativePath}`);
        return;
      }

      // Run all processors in parallel
      const results = await Promise.allSettled(
        this.processors.map(processor => processor.process(event))
      );

      // Log results
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { success, processorName, duration, error } = result.value;
          if (success) {
            logger.debug(`✓ ${processorName} completed in ${duration}ms`);
          } else {
            logger.error(`✗ ${processorName} failed:`, error);
          }
        } else {
          logger.error(`Processor ${this.processors[index].name} crashed:`, result.reason);
        }
      });

      // Update file state
      await this.updateFileState(event);
    } catch (error) {
      logger.error('Error processing file event:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async shouldSkipFile(event: FileEvent): Promise<boolean> {
    // Always process deletions
    if (event.type === 'deleted') {
      return false;
    }

    try {
      const content = await fs.readFile(event.path, 'utf-8');
      const hash = this.hashContent(content);

      const state = this.fileStates.get(event.relativePath);
      if (state && state.hash === hash) {
        return true; // File hasn't changed
      }
    } catch (error) {
      // File might not exist or be readable, process it anyway
      return false;
    }

    return false;
  }

  private async updateFileState(event: FileEvent): Promise<void> {
    if (event.type === 'deleted') {
      this.fileStates.delete(event.relativePath);
      return;
    }

    try {
      const content = await fs.readFile(event.path, 'utf-8');
      const hash = this.hashContent(content);

      this.fileStates.set(event.relativePath, {
        hash,
        lastProcessed: new Date(),
      });
    } catch (error) {
      logger.error(`Failed to update state for ${event.relativePath}:`, error);
    }
  }

  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private async loadState(): Promise<void> {
    try {
      const stateData = await fs.readFile(this.stateFile, 'utf-8');
      const parsed = JSON.parse(stateData);

      // Reconstruct the Map from the saved data
      this.fileStates = new Map(
        Object.entries(parsed).map(([key, value]: [string, any]) => [
          key,
          {
            hash: value.hash,
            lastProcessed: new Date(value.lastProcessed),
          },
        ])
      );

      logger.debug(`Loaded state for ${this.fileStates.size} files`);
    } catch (error) {
      // State file doesn't exist or is invalid, start fresh
      logger.debug('No existing state file, starting fresh');
      this.fileStates = new Map();
    }
  }

  private async saveState(): Promise<void> {
    try {
      // Ensure .dome directory exists
      const domeDir = path.dirname(this.stateFile);
      await fs.mkdir(domeDir, { recursive: true });

      // Convert Map to plain object for JSON serialization
      const stateObj: Record<string, FileState> = {};
      for (const [key, value] of this.fileStates.entries()) {
        stateObj[key] = value;
      }

      await fs.writeFile(this.stateFile, JSON.stringify(stateObj, null, 2));
      logger.debug(`Saved state for ${this.fileStates.size} files`);
    } catch (error) {
      logger.error('Failed to save state:', error);
    }
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

    // Save state periodically (every 5 minutes)
    setInterval(
      () => {
        if (!this.shutdownRequested) {
          this.saveState().catch(err =>
            logger.error('Failed to save state during periodic save:', err)
          );
        }
      },
      5 * 60 * 1000
    );
  }
}
