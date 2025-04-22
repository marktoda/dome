/**
 * Silo Service Module
 *
 * This module provides a client for interacting with the Silo service.
 * It handles uploading content to Silo via R2 storage.
 *
 * @module services/siloService
 */
import { SiloSimplePutInput, SiloSimplePutResponse } from '@dome/common';
import { SiloService as SiloBinding } from '../types';

/**
 * Silo Service Client
 *
 * Service for interacting with the Silo service.
 * Provides methods to upload content to Silo.
 *
 * @class
 */
export class SiloService {
  /** Silo service binding */
  private silo: SiloBinding;

  /**
   * Create a new SiloService
   *
   * @param env - The environment bindings
   */
  constructor(private env: Env) {
    this.silo = env.SILO as unknown as SiloBinding;
  }

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
   * Upload a single content item to Silo
   *
   * Creates a pre-signed POST policy for the content and uploads it to R2.
   *
   * @param content - Content item to upload
   * @returns Content ID
   * @throws Error if the upload fails
   */
  async uploadSingle(content: SiloSimplePutInput): Promise<SiloSimplePutResponse> {
    return await this.silo.simplePut(content);
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
export function createSiloService(env: Env): SiloService {
  return new SiloService(env);
}
