/**
 * Providers Module
 *
 * This module defines the Provider interface and common types for
 * external content providers in the Tsunami service.
 *
 * @module providers
 */

import { SiloSimplePutInput } from '@dome/common';

/**
 * Provider types supported by the ResourceObject
 *
 * @enum {string}
 */
export enum ProviderType {
  /** GitHub repository provider */
  GITHUB = 'GITHUB',
  /** Notion document provider */
  NOTION = 'NOTION',
  /** Website provider */
  WEBSITE = 'WEBSITE',
}

/**
 * Options for pulling content from a provider
 *
 * @interface PullOpts
 */
export type PullOpts = {
  /** User ID who owns the OAuth token */
  userId?: string;
  /** Resource identifier (repo name, page id, project key, etc.) */
  resourceId: string;
  /** Provider-defined cursor for incremental syncs (commit SHA, block timestamp, etc.) */
  cursor: string | null;
};

export type PullResult = {
  contents: SiloSimplePutInput[];
  newCursor: string | null;
};

/**
 * Provider Interface
 *
 * A source of external content tied to a single user + resource.
 * Implementations MUST be pure-async (no globals) so they can be run
 * inside a Durable Object or a cron worker.
 *
 * @interface Provider
 */
export interface Provider {
  /**
   * Pull incremental changes since cursor
   *
   * Called on a schedule (cron or Durable Object alarm).
   *
   * @param opts - Pull options including userId, resourceId, and cursor
   * @returns Array of SiloSimplePutInput objects
   */
  pull(opts: PullOpts): Promise<PullResult>;
}

// Export provider implementations
export { GithubProvider } from './github';
export { NotionProvider } from './notion';
export { WebsiteProvider } from './website';
