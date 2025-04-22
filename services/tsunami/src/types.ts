/**
 * Tsunami Service Types
 *
 * This file defines internal types used by the Tsunami service that are not
 * exposed to external consumers. These types support the internal implementation
 * of the service's core functionality.
 *
 * @module types
 */

import {
  SiloSimplePutInput,
  SiloSimplePutResponse,
  SiloBatchGetInput,
  SiloBatchGetResponse,
} from '@dome/common';

/**
 * Silo Service Interface
 *
 * Defines the methods available on the Silo service binding.
 *
 * @interface SiloService
 */
export interface SiloService {
  /**
   * Batch get content from Silo
   *
   * @param data - Batch get input parameters
   * @returns Batch get response with content items
   */
  batchGet(data: SiloBatchGetInput): Promise<SiloBatchGetResponse>;
}

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
  SILO: SiloService;
  /** Ingest queue for content ingestion */
  SILO_INGEST_QUEUE: Queue<SiloSimplePutInput>;
  /** Resource Object Durable Object */
  RESOURCE_OBJECT: DurableObjectNamespace;
};
