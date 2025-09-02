import logger from '../core/utils/logger.js';
import { EventQueue } from './EventQueue.js';
import { FileStateStore } from './FileStateStore.js';
import { FileEvent, FileEventType } from './types.js';
import { FileProcessor } from '../core/processors/FileProcessor.js';
import { ProcessorLockManager } from './ProcessorLockManager.js';

export class EventProcessor {
  private running = false;
  private readonly lockManager: ProcessorLockManager;

  constructor(
    private readonly queue: EventQueue,
    private readonly state: FileStateStore,
    private readonly processors: FileProcessor[]
  ) {
    this.lockManager = new ProcessorLockManager();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    void this.processLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.queue.onIdle();
    this.lockManager.clearAllLocks();
  }

  private async processLoop(): Promise<void> {
    this.queue.setProcessing(true);

    while (this.running) {
      const event = await this.queue.pull();

      if (!event) {
        this.queue.setProcessing(false);
        await this.sleep(100);
        if (!this.queue.isEmpty()) {
          this.queue.setProcessing(true);
        }
        continue;
      }

      await this.processEvent(event);
    }

    this.queue.setProcessing(false);
  }

  private async processEvent(event: FileEvent): Promise<void> {
    const lockAcquired = await this.lockManager.acquireLock(
      event.relativePath,
      async () => {
        logger.info(`Processing ${event.type}: ${event.relativePath}`);
        try {
          if (event.type === FileEventType.Deleted) {
            await this.runProcessors(event);
            this.state.delete(event.relativePath);
            return;
          }

          const hash = await this.state.computeHash(event.path);
          const prev = this.state.get(event.relativePath);

          if (prev?.hash === hash) {
            logger.debug(`Skipping unchanged: ${event.relativePath}`);
            return;
          }

          await this.runProcessors(event);
          this.state.upsert(event.relativePath, hash);
        } catch (err) {
          logger.error(`Error processing ${event.relativePath}: ${err}`);
          throw err;
        }
      }
    );

    if (!lockAcquired) {
      logger.info(`Skipped processing ${event.relativePath} - already being processed`);
    }
  }

  private async runProcessors(event: FileEvent): Promise<void> {
    const results = await Promise.allSettled(
      this.processors.map(p => p.process(event))
    );

    results.forEach((result, i) => {
      const name = this.processors[i].name;

      if (result.status === 'rejected') {
        logger.error(`${name} crashed: ${result.reason}`);
        return;
      }

      const { success, duration, error } = result.value;
      if (success) {
        logger.debug(`✓ ${name} (${duration}ms)`);
      } else {
        logger.error(`✗ ${name}: ${error?.message}`);
      }
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
