// Import and re-export types from the watcher module for backward compatibility
import { FileEventType, FileEvent } from '../../watcher/types.js';
export { FileEventType, FileEvent };

export interface ProcessorResult {
  success: boolean;
  processorName: string;
  duration: number;
  error?: Error;
}

export abstract class FileProcessor {
  abstract readonly name: string;

  async process(event: FileEvent): Promise<ProcessorResult> {
    const startTime = Date.now();

    try {
      await this.processFile(event);

      return {
        success: true,
        processorName: this.name,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        processorName: this.name,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  protected abstract processFile(event: FileEvent): Promise<void>;
}
