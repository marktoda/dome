import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WorkerMessage {
  type: 'progress' | 'complete' | 'error';
  progress?: number;
  error?: string;
  noteCount?: number;
  indexedCount?: number;
}

export class IndexWorker extends EventEmitter {
  private worker: Worker | null = null;
  private isRunning = false;
  private lastIndexTime = 0;
  private restartCount = 0;
  private maxRestarts = 2;

  async start(vaultPath: string): Promise<void> {
    if (this.isRunning) {
      return;
    }

    try {
      this.isRunning = true;
      
      // Create worker thread
      this.worker = new Worker(
        join(__dirname, '../worker/indexer.js'),
        {
          workerData: { vaultPath }
        }
      );

      // Handle messages from worker
      this.worker.on('message', (message: WorkerMessage) => {
        switch (message.type) {
          case 'progress':
            this.emit('progress', {
              progress: message.progress || 0,
              noteCount: message.noteCount || 0,
              indexedCount: message.indexedCount || 0,
            });
            break;

          case 'complete':
            this.lastIndexTime = Date.now();
            this.emit('complete', {
              noteCount: message.noteCount || 0,
              indexedCount: message.indexedCount || 0,
            });
            this.cleanup();
            break;

          case 'error':
            this.emit('error', new Error(message.error || 'Unknown error'));
            this.cleanup();
            break;
        }
      });

      // Handle worker errors
      this.worker.on('error', (error) => {
        this.emit('error', error);
        this.handleWorkerCrash();
      });

      // Handle worker exit
      this.worker.on('exit', (code) => {
        if (code !== 0) {
          this.emit('error', new Error(`Worker exited with code ${code}`));
          this.handleWorkerCrash();
        }
      });

    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.cleanup();
    }
  }

  private cleanup(): void {
    this.worker = null;
    this.isRunning = false;
    this.restartCount = 0;
  }

  private async handleWorkerCrash(): Promise<void> {
    this.cleanup();

    // Auto-restart logic
    if (this.restartCount < this.maxRestarts) {
      this.restartCount++;
      this.emit('restarting', this.restartCount);
      
      // Wait a bit before restarting
      await new Promise(resolve => setTimeout(resolve, 1000 * this.restartCount));
      
      try {
        const vaultPath = process.env.DOME_VAULT_PATH || `${process.env.HOME}/dome`;
        await this.start(vaultPath);
      } catch (error) {
        this.emit('error', new Error(`Failed to restart worker: ${error}`));
      }
    } else {
      this.emit('error', new Error('Worker crashed too many times, giving up'));
    }
  }

  getStatus() {
    return {
      running: this.isRunning,
      lastIndexTime: this.lastIndexTime,
    };
  }
}