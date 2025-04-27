import type { MessageData, SiloSimplePutInput } from '@dome/common';
import type { AiProcessorBinding } from '@dome/ai-processor/client';
import { SiloBinding } from '@dome/silo/client';
import { ChatBinding } from '@dome/chat/client';
import { TsunamiBinding } from '@dome/tsunami/client';

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
  SILO_INGEST_QUEUE: Queue<SiloSimplePutInput>; // Queue for content ingestion
  AI?: WorkersAI; // Optional to support testing environments
  CONSTELLATION?: Fetcher; // Optional to support testing environments
  SILO: SiloBinding; // Silo service binding
  CHAT: ChatBinding; // Chat service binding
  TSUNAMI: TsunamiBinding; // Tsunami service binding
  AI_PROCESSOR: AiProcessorBinding; // AI processor service binding
  VERSION?: string; // Version of the service
  ENVIRONMENT?: string; // Environment (development, staging, production)
};
