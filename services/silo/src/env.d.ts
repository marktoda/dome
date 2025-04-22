/**
 * Environment interface for the Silo service
 * This defines the bindings available in the Cloudflare Workers environment
 */
import { NewContentMessage, SiloSimplePutInput } from '@dome/common';
interface Env {
  // R2 bucket for content storage
  BUCKET: R2Bucket;

  // D1 database for metadata
  DB: D1Database;

  // Queue bindings
  NEW_CONTENT_CONSTELLATION: Queue<NewContentMessage>;
  NEW_CONTENT_AI: Queue<NewContentMessage>;
  INGEST_QUEUE: Queue<SiloSimplePutInput>;

  // Environment variables
  LOG_LEVEL: string;
  VERSION: string;
  ENVIRONMENT: string;
}
