import { EventEmitter } from 'events';
import { backgroundIndexer } from '../../../mastra/core/search.js';
import { noteEvents, IndexProgressEvent } from '../../../mastra/core/events.js';

/**
 * Thin wrapper that exposes the *same* event interface the old worker thread
 * implementation offered, but delegates all work to the shared
 * `backgroundIndexer` in the main thread.
 */
export class IndexWorker extends EventEmitter {
  private isRunning = false;

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;

    // Forward progress events
    const listener = (evt: IndexProgressEvent) => {
      this.emit(evt.type, evt);
    };
    noteEvents.on('index:progress', listener);
    noteEvents.on('index:complete', listener);
    noteEvents.on('index:updated', listener);

    // Start background indexer (no harm if already running)
    await backgroundIndexer.startBackgroundIndexing();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    await backgroundIndexer.stopBackgroundIndexing();
    this.isRunning = false;
  }

  getStatus() {
    return backgroundIndexer.getStatus();
  }
}
