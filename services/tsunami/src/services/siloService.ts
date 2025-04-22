/**
 * Silo Service Module
 *
 * This module provides a client for interacting with the Silo service.
 * It handles uploading content to Silo via the ingest queue.
 *
 * @module services/siloService
 */
import { SiloSimplePutInput, SiloSimplePutResponse } from '@dome/common';
import { ulid } from 'ulid';
import { Bindings } from '../types';

/**
 * Silo Service Client
 *
 * Service for interacting with the Silo service.
 * Provides methods to upload content to Silo via the ingest queue.
 *
 * @class
 */
export class SiloService {
  /**
   * Create a new SiloService
   *
   * @param env - The environment bindings
   */
  constructor(private env: Bindings) {}

  /**
   * Upload multiple content items to Silo
   *
   * @param contents - Array of content items to upload
   * @returns Array of content IDs
   */
  async upload(contents: SiloSimplePutInput[]): Promise<string[]> {
    const results = await Promise.all(contents.map(c => this.uploadSingle(c)));
    return results.map(r => r.id);
  }

  /**
   * Upload a single content item to Silo via the ingest queue
   *
   * @param content - Content item to upload
   * @returns Content ID and metadata
   * @throws Error if the upload fails
   */
  async uploadSingle(content: SiloSimplePutInput): Promise<SiloSimplePutResponse> {
    const id = content.id || ulid();
    const createdAt = Math.floor(Date.now() / 1000);

    // Create a message for the ingest queue
    const message: SiloSimplePutInput = {
      id,
      userId: content.userId || undefined,
      content: content.content,
      category: content.category || 'note',
      mimeType: content.mimeType || 'text/markdown',
      metadata: content.metadata,
    };

    // Send the message to the ingest queue
    await this.env.INGEST_QUEUE.send(message);

    // Return a response with the ID
    return {
      id,
      category: content.category || 'note',
      mimeType: content.mimeType || 'text/markdown',
      size:
        typeof content.content === 'string'
          ? new TextEncoder().encode(content.content).length
          : content.content.byteLength,
      createdAt,
    };
  }
}

/**
 * Create a new SiloService
 *
 * Factory function to create a new SiloService instance.
 *
 * @param env - The environment bindings
 * @returns A new SiloService instance
 */
export function createSiloService(env: Bindings): SiloService {
  return new SiloService(env);
}
