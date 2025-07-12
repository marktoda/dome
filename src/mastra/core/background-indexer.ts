import fs from "node:fs/promises";
import { join } from "node:path";
import { listNotes, type NoteMeta } from "./notes.js";
import { indexAllNotes, createVectorStore } from "./search-indexer.js";

interface IndexingState {
  isRunning: boolean;
  lastIndexTime: number;
  pendingFiles: Set<string>;
  indexingPromise: Promise<void> | null;
  showStatus: boolean;
}

class BackgroundIndexer {
  private state: IndexingState = {
    isRunning: false,
    lastIndexTime: 0,
    pendingFiles: new Set(),
    indexingPromise: null,
    showStatus: true
  };

  private vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
  private readonly INDEXING_INTERVAL = 30000; // 30 seconds
  private readonly DEBOUNCE_DELAY = 5000; // 5 seconds

  /**
   * Start background indexing during chat session
   */
  async startBackgroundIndexing(): Promise<void> {
    if (this.state.isRunning) return;
    
    this.state.isRunning = true;
    if (this.state.showStatus) {
      this.logStatus('🔍 Background indexing started');
    }
    
    // Initial quick check (non-blocking)
    this.scheduleIndexingIfNeeded().catch(err => 
      console.error('Initial indexing check failed:', err)
    );
    
    // Set up periodic indexing
    this.schedulePeriodicIndexing();
  }

  /**
   * Stop background indexing
   */
  async stopBackgroundIndexing(): Promise<void> {
    this.state.isRunning = false;
    
    // Wait for any ongoing indexing to complete
    if (this.state.indexingPromise) {
      await this.state.indexingPromise;
    }
    
    console.log('🔍 Background indexing stopped');
  }

  /**
   * Check if indexing is needed and schedule it
   */
  private async scheduleIndexingIfNeeded(): Promise<void> {
    if (!this.state.isRunning || this.state.indexingPromise) return;

    try {
      const needsIndexing = await this.checkIfIndexingNeeded();
      if (needsIndexing) {
        this.state.indexingPromise = this.performBackgroundIndexing();
        await this.state.indexingPromise;
        this.state.indexingPromise = null;
      }
    } catch (error) {
      console.error('Background indexing check failed:', error);
      this.state.indexingPromise = null;
    }
  }

  /**
   * Set up periodic indexing checks
   */
  private schedulePeriodicIndexing(): void {
    if (!this.state.isRunning) return;

    setTimeout(async () => {
      await this.scheduleIndexingIfNeeded();
      if (this.state.isRunning) {
        this.schedulePeriodicIndexing();
      }
    }, this.INDEXING_INTERVAL);
  }

  /**
   * Check if indexing is needed based on file modifications
   */
  private async checkIfIndexingNeeded(): Promise<boolean> {
    try {
      const notes = await listNotes();
      const dbPath = process.env.LANCE_DB_PATH ?? `${this.vaultPath}/.vector_db`;
      
      // Check if vector DB exists
      try {
        await fs.access(dbPath);
      } catch {
        return true; // DB doesn't exist, need initial indexing
      }

      // Check if any notes are newer than last index time
      for (const note of notes) {
        const fullPath = join(this.vaultPath, note.path);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.mtime.getTime() > this.state.lastIndexTime) {
            return true;
          }
        } catch {
          // File might have been deleted, continue checking others
          continue;
        }
      }

      return false;
    } catch (error) {
      console.error('Error checking indexing needs:', error);
      return false;
    }
  }

  /**
   * Perform the actual background indexing
   */
  private async performBackgroundIndexing(): Promise<void> {
    try {
      if (this.state.showStatus) {
        this.logStatus('🔄 Indexing notes...');
      }
      await indexAllNotes();
      this.state.lastIndexTime = Date.now();
      if (this.state.showStatus) {
        this.logStatus('✅ Background indexing completed');
      }
    } catch (error) {
      console.error('❌ Background indexing failed:', error);
    }
  }

  /**
   * Log status messages without disrupting chat input
   */
  private logStatus(message: string): void {
    // Clear current line, print status, then restore prompt
    process.stdout.write('\r\x1b[K'); // Clear line
    console.log(message);
    process.stdout.write('> '); // Restore prompt
  }

  /**
   * Force a background index (useful for testing)
   */
  async forceIndex(): Promise<void> {
    if (this.state.indexingPromise) {
      console.log('Indexing already in progress, waiting...');
      await this.state.indexingPromise;
      return;
    }

    this.state.indexingPromise = this.performBackgroundIndexing();
    await this.state.indexingPromise;
    this.state.indexingPromise = null;
  }

  /**
   * Get current indexing status
   */
  getStatus(): { isRunning: boolean; isIndexing: boolean; lastIndexTime: number } {
    return {
      isRunning: this.state.isRunning,
      isIndexing: this.state.indexingPromise !== null,
      lastIndexTime: this.state.lastIndexTime
    };
  }

  /**
   * Enable or disable status messages
   */
  setStatusDisplay(show: boolean): void {
    this.state.showStatus = show;
  }
}

// Singleton instance
export const backgroundIndexer = new BackgroundIndexer();