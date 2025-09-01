import path from 'node:path';
import logger from '../core/utils/logger.js';
import { FileWatcher } from './FileWatcher.js';
import { FileStateStore } from './FileStateStore.js';
import { EventQueue } from './EventQueue.js';
import { EventProcessor } from './EventProcessor.js';
import { TodoProcessor } from '../core/processors/TodoProcessor.js';
import { EmbeddingProcessor } from '../core/processors/EmbeddingProcessor.js';
import { IndexProcessor } from '../core/processors/IndexProcessor.js';
import { FrontmatterProcessor } from '../core/processors/FrontmatterProcessor.js';
import { SequentialProcessor } from '../core/processors/SequentialProcessor.js';
import { NoteSummarizer } from '../core/services/NoteSummarizer.js';
import { getWatcherConfig } from './config.js';

export class WatcherService {
  private readonly watcher: FileWatcher;
  private readonly state: FileStateStore;
  private readonly queue = new EventQueue();
  private readonly processor: EventProcessor;
  private saveInterval?: NodeJS.Timeout;

  constructor() {
    const config = getWatcherConfig();

    this.watcher = new FileWatcher({
      vaultPath: config.vaultPath,
      ignored: config.ignore,
      debounceMs: config.debounce.fileChangeMs,
      awaitWriteFinish: config.debounce.awaitWriteFinish,
      ignoreInitial: true,
    });

    this.state = new FileStateStore(
      path.join(config.stateDir, 'watcher-state.json')
    );

    const sequentialProcessors = [
      new FrontmatterProcessor({
        model: 'gpt-5-mini',
        overwriteExisting: false,
        fieldsToExtract: ['title', 'tags', 'participants', 'summary', 'topics', 'type']
      }),
      new IndexProcessor({
        summarizer: new NoteSummarizer({ model: 'gpt-5-mini' })
      }),
    ];

    const processors = [
      new TodoProcessor(),
      new EmbeddingProcessor(),
      new SequentialProcessor(sequentialProcessors, 'FrontmatterAndIndex'),
    ];

    this.processor = new EventProcessor(this.queue, this.state, processors);
    this.watcher.on('file', e => this.queue.add(e));
  }

  async start(): Promise<void> {
    logger.info('Starting watcher service');

    await this.state.load();
    this.setupPeriodicSave();
    this.setupShutdownHandlers();

    await this.processor.start();
    await this.watcher.start();

    logger.info('Watcher service started');
  }

  async stop(): Promise<void> {
    logger.info('Stopping watcher service');

    await this.watcher.stop();
    await this.processor.stop();
    await this.queue.onIdle();
    await this.state.save();

    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }

    logger.info('Watcher service stopped');
  }

  private setupPeriodicSave(): void {
    this.saveInterval = setInterval(
      () => this.state.save().catch(err =>
        logger.error(`Failed periodic save: ${err}`)
      ),
      5 * 60 * 1000
    );
  }

  private setupShutdownHandlers(): void {
    const shutdown = async () => {
      await this.stop();
      process.exit(0);
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}

