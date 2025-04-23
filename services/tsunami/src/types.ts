/**
 * Tsunami Service Types
 *
 * This file defines internal types used by the Tsunami service that are not
 * exposed to external consumers. These types support the internal implementation
 * of the service's core functionality.
 *
 * @module types
 */

import { SiloSimplePutInput } from '@dome/common';

/**
 * Environment Bindings
 *
 * Defines the bindings available in the Cloudflare Workers environment.
 *
 * @interface Bindings
 */
export type Bindings = {
  /** D1 database for sync plan storage */
  SYNC_PLAN: D1Database;
  /** Silo service binding for content storage */
  SILO: Fetcher;
  /** Ingest queue for content ingestion */
  SILO_INGEST_QUEUE: Queue<SiloSimplePutInput>;
  /** Resource Object Durable Object */
  RESOURCE_OBJECT: DurableObjectNamespace;
};
