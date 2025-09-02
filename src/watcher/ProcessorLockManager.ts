import logger from '../core/utils/logger.js';

export class ProcessorLockManager {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly lockTimeout: number;

  constructor(lockTimeout = 30000) {
    this.lockTimeout = lockTimeout;
  }

  async acquireLock(filePath: string, operation: () => Promise<void>): Promise<boolean> {
    const existingLock = this.locks.get(filePath);
    
    if (existingLock) {
      logger.debug(`Lock already held for ${filePath}, skipping processing`);
      return false;
    }

    const lockPromise = this.createLockPromise(filePath, operation);
    this.locks.set(filePath, lockPromise);
    
    try {
      await lockPromise;
      return true;
    } finally {
      if (this.locks.get(filePath) === lockPromise) {
        this.locks.delete(filePath);
      }
    }
  }

  private createLockPromise(filePath: string, operation: () => Promise<void>): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        logger.warn(`Lock timeout for ${filePath} after ${this.lockTimeout}ms`);
        reject(new Error(`Lock timeout for ${filePath}`));
      }, this.lockTimeout);

      try {
        await operation();
        clearTimeout(timeoutId);
        resolve();
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  isLocked(filePath: string): boolean {
    return this.locks.has(filePath);
  }

  getLockCount(): number {
    return this.locks.size;
  }

  clearAllLocks(): void {
    this.locks.clear();
  }
}