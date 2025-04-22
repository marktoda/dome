/**
 * Silo Service Module
 *
 * This module provides a client for interacting with the Silo service.
 * It handles uploading content to Silo via R2 storage.
 *
 * @module services/siloService
 */

import { getLogger, metrics } from '@dome/logging';
import { z } from 'zod';
import {
  SiloSimplePutInput,
  SiloCreateUploadResponse,
  SiloEmbedJob,
  ContentCategory,
  MimeType,
  NewContentMessageSchema,
  NewContentMessage,
} from '@dome/common';
import { SiloService as SiloBinding } from '../types';

/** Expiration time for upload URLs in seconds (10 minutes) */
const UPLOAD_EXPIRATION_SECONDS = 600;

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
    const contentIds: string[] = [];
    
    for (const content of contents) {
      const id = await this.uploadSingle(content);
      contentIds.push(id);
    }
    
    return contentIds;
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
  async uploadSingle(content: SiloSimplePutInput) {
    const size = typeof content.content === 'string' ? content.content.length : content.content.byteLength;

    const { id, uploadUrl, formData, expiresIn } = await this.silo.createUpload({
      category: content.category,
      mimeType: content.mimeType,
      size,
      metadata: content.metadata,
      expirationSeconds: UPLOAD_EXPIRATION_SECONDS,
      userId: content.userId,
    });

    getLogger().info({ id, uploadUrl }, 'Upload single data!');

    try {
      // Create a FormData object for the upload
      const form = new FormData();
      
      // Add all the form fields from the formData object
      for (const [key, value] of Object.entries(formData)) {
        form.append(key, value);
      }
      
      // Add the content as the file data
      // The key 'file' is typically used for the file field in R2 pre-signed POST policies
      const blob = typeof content.content === 'string'
        ? new Blob([content.content], { type: content.mimeType })
        : new Blob([content.content], { type: content.mimeType });
      
      form.append('file', blob);
      
      // Send the POST request to the uploadUrl
      const response = await fetch(uploadUrl, {
        method: 'POST',
        body: form,
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed with status ${response.status}: ${errorText}`);
      }
      
      metrics.increment('tsunami.silo.upload.success', 1);
      getLogger().info({ id, size }, 'Content uploaded successfully to R2');
      
      return id;
    } catch (error) {
      metrics.increment('tsunami.silo.upload.error', 1);
      getLogger().error({ error, id }, 'Error uploading content to R2');
      throw error;
    }
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
