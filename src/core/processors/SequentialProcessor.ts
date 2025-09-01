import { FileProcessor, FileEvent } from './FileProcessor.js';
import logger from '../utils/logger.js';

export class SequentialProcessor extends FileProcessor {
  readonly name: string;
  
  constructor(
    private readonly processors: FileProcessor[],
    name?: string
  ) {
    super();
    this.name = name ?? `Sequential[${processors.map(p => p.name).join(', ')}]`;
  }

  protected async processFile(event: FileEvent): Promise<void> {
    for (const processor of this.processors) {
      try {
        const result = await processor.process(event);
        
        if (!result.success) {
          logger.warn(`${result.processorName} failed: ${result.error?.message}`);
        } else {
          logger.debug(`✓ ${result.processorName} (${result.duration}ms)`);
        }
      } catch (error) {
        logger.error(`${processor.name} crashed: ${error}`);
      }
    }
  }
}