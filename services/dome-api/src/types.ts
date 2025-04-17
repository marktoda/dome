import type { MessageData } from '@dome/common';

/**
 * Interface for Workers AI binding
 */
interface WorkersAI {
  run(model: string, options: any): Promise<any>;
}

export type Bindings = {
  D1_DATABASE: D1Database;
  VECTORIZE: VectorizeIndex;
  RAW: R2Bucket;
  EVENTS: Queue<MessageData>;
  AI?: WorkersAI; // Optional to support testing environments
};
