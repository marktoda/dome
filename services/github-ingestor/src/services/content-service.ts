import { ulid } from 'ulid';
import { contentBlobs } from '../db/schema';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { Env } from '../types';
import { initPolyfills } from '../utils/polyfills';

// Initialize polyfills
initPolyfills();
import { calculateSha1, generateR2Key } from '../github/content-utils';

/**
 * Content metadata
 */
export interface ContentMetadata {
  sha: string;
  size: number;
  mimeType: string;
  r2Key: string;
}

/**
 * Content reference
 */
export interface ContentReference {
  id: string;
  repoId: string;
  path: string;
  sha: string;
  size: number;
  mimeType: string;
}

/**
 * Service for managing content in Silo
 */
export class ContentService {
  private env: Env;

  /**
   * Create a new content service
   * @param env Environment
   */
  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Store content in Silo
   * @param content Content as string or ReadableStream
   * @param metadata Content metadata
   * @returns Content SHA-1 hash
   */
  async storeContent(
    content: string | globalThis.ReadableStream,
    metadata: Partial<ContentMetadata>,
  ): Promise<ContentMetadata> {
    const timer = metrics.startTimer('content_service.store_content');

    try {
      // Calculate SHA-1 hash if not provided
      let sha = metadata.sha;
      if (!sha) {
        if (typeof content === 'string') {
          sha = await calculateSha1(content);
        } else {
          throw new Error('SHA-1 hash must be provided for streaming content');
        }
      }

      // Check if content already exists
      const existingBlob = await this.env.DB.prepare(
        `
        SELECT sha, size, r2Key, mimeType
        FROM content_blobs
        WHERE sha = ?
      `,
      )
        .bind(sha)
        .first<ContentMetadata>();

      if (existingBlob) {
        logger().info({ sha }, 'Content already exists, skipping storage');
        timer.stop({ exists: 'true' });
        return existingBlob;
      }

      // Generate R2 key if not provided
      const r2Key =
        metadata.r2Key || generateR2Key(sha, metadata.mimeType || 'application/octet-stream');

      // Determine content size
      let size = metadata.size;
      if (size === undefined && typeof content === 'string') {
        size = new TextEncoder().encode(content).length;
      }

      if (size === undefined) {
        throw new Error('Content size must be provided for streaming content');
      }

      // Store content in Silo
      const response = await this.env.SILO.fetch('http://silo/blobs', {
        method: 'PUT',
        headers: {
          'Content-Type': metadata.mimeType || 'application/octet-stream',
          'X-Silo-Key': r2Key,
          'X-Silo-SHA': sha,
        },
        body: content,
      });

      if (!response.ok) {
        throw new Error(
          `Failed to store content in Silo: ${response.status} ${response.statusText}`,
        );
      }

      // Store metadata in database
      const now = Math.floor(Date.now() / 1000);

      await this.env.DB.prepare(
        `
        INSERT INTO content_blobs (sha, size, r2Key, mimeType, createdAt)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
        .bind(sha, size, r2Key, metadata.mimeType || 'application/octet-stream', now)
        .run();

      const contentMetadata: ContentMetadata = {
        sha,
        size,
        mimeType: metadata.mimeType || 'application/octet-stream',
        r2Key,
      };

      logger().info({ sha, size, r2Key }, 'Stored content in Silo');

      metrics.counter('content_service.content_stored', 1, {
        mime_type: contentMetadata.mimeType,
      });
      metrics.counter('content_service.bytes_stored', size, {
        mime_type: contentMetadata.mimeType,
      });

      timer.stop({ new: 'true' });
      return contentMetadata;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, 'Failed to store content in Silo');
      throw error;
    }
  }

  /**
   * Check if content exists in Silo
   * @param sha Content SHA-1 hash
   * @returns Whether the content exists
   */
  async contentExists(sha: string): Promise<boolean> {
    const timer = metrics.startTimer('content_service.content_exists');

    try {
      const blob = await this.env.DB.prepare(
        `
        SELECT sha
        FROM content_blobs
        WHERE sha = ?
      `,
      )
        .bind(sha)
        .first();

      const exists = !!blob;

      timer.stop({ exists: exists.toString() });
      return exists;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to check if content ${sha} exists`);
      throw error;
    }
  }

  /**
   * Get content metadata
   * @param sha Content SHA-1 hash
   * @returns Content metadata or null if not found
   */
  async getContentMetadata(sha: string): Promise<ContentMetadata | null> {
    const timer = metrics.startTimer('content_service.get_content_metadata');

    try {
      const blob = await this.env.DB.prepare(
        `
        SELECT sha, size, r2Key, mimeType
        FROM content_blobs
        WHERE sha = ?
      `,
      )
        .bind(sha)
        .first<ContentMetadata>();

      timer.stop({ found: blob ? 'true' : 'false' });
      return blob || null;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to get content metadata for ${sha}`);
      throw error;
    }
  }

  /**
   * Add a content reference
   * @param reference Content reference
   * @returns Whether the reference was added
   */
  async addContentReference(reference: ContentReference): Promise<boolean> {
    const timer = metrics.startTimer('content_service.add_content_reference');

    try {
      const now = Math.floor(Date.now() / 1000);

      // Check if the reference already exists
      const existingRef = await this.env.DB.prepare(
        `
        SELECT id
        FROM repository_files
        WHERE repoId = ? AND path = ?
      `,
      )
        .bind(reference.repoId, reference.path)
        .first<{ id: string }>();

      if (existingRef) {
        // Update existing reference
        await this.env.DB.prepare(
          `
          UPDATE repository_files
          SET sha = ?, size = ?, mimeType = ?, updatedAt = ?
          WHERE id = ?
        `,
        )
          .bind(reference.sha, reference.size, reference.mimeType, now, existingRef.id)
          .run();

        timer.stop({ updated: 'true' });
        return true;
      } else {
        // Insert new reference
        const id = reference.id || ulid();

        await this.env.DB.prepare(
          `
          INSERT INTO repository_files (id, repoId, path, sha, size, mimeType, lastModified, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
          .bind(
            id,
            reference.repoId,
            reference.path,
            reference.sha,
            reference.size,
            reference.mimeType,
            now,
            now,
            now,
          )
          .run();

        timer.stop({ created: 'true' });
        return true;
      }
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to add content reference for ${reference.path}`);
      throw error;
    }
  }

  /**
   * Get content references
   * @param sha Content SHA-1 hash
   * @returns Array of content references
   */
  async getContentReferences(sha: string): Promise<ContentReference[]> {
    const timer = metrics.startTimer('content_service.get_content_references');

    try {
      const results = await this.env.DB.prepare(
        `
        SELECT id, repoId, path, sha, size, mimeType
        FROM repository_files
        WHERE sha = ?
      `,
      )
        .bind(sha)
        .all<ContentReference>();

      timer.stop({ count: results.results.length.toString() });
      return results.results;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to get content references for ${sha}`);
      throw error;
    }
  }

  /**
   * Delete content references for a repository
   * @param repoId Repository ID
   * @returns Number of references deleted
   */
  async deleteContentReferencesForRepository(repoId: string): Promise<number> {
    const timer = metrics.startTimer('content_service.delete_content_references_for_repository');

    try {
      const result = await this.env.DB.prepare(
        `
        DELETE FROM repository_files
        WHERE repoId = ?
      `,
      )
        .bind(repoId)
        .run();

      const deleted = result.meta.changes || 0;

      if (deleted > 0) {
        logger().info({ repoId, count: deleted }, 'Deleted content references for repository');
        metrics.counter('content_service.references_deleted', deleted);
      }

      timer.stop({ deleted: deleted.toString() });
      return deleted;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to delete content references for repository ${repoId}`);
      throw error;
    }
  }

  /**
   * Get content from Silo
   * @param sha Content SHA-1 hash
   * @returns Content as a ReadableStream
   */
  async getContent(sha: string): Promise<globalThis.ReadableStream> {
    const timer = metrics.startTimer('content_service.get_content');

    try {
      // Get content metadata
      const metadata = await this.getContentMetadata(sha);

      if (!metadata) {
        throw new Error(`Content not found: ${sha}`);
      }

      // Get content from Silo
      const response = await this.env.SILO.fetch(`http://silo/blobs/${metadata.r2Key}`);

      if (!response.ok) {
        throw new Error(
          `Failed to get content from Silo: ${response.status} ${response.statusText}`,
        );
      }

      timer.stop({ size: metadata.size.toString() });
      return response.body as globalThis.ReadableStream;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to get content ${sha}`);
      throw error;
    }
  }

  /**
   * Delete content from Silo
   * @param sha Content SHA-1 hash
   * @returns Whether the content was deleted
   */
  async deleteContent(sha: string): Promise<boolean> {
    const timer = metrics.startTimer('content_service.delete_content');

    try {
      // Get content metadata
      const metadata = await this.getContentMetadata(sha);

      if (!metadata) {
        timer.stop({ found: 'false' });
        return false;
      }

      // Check if content is still referenced
      const references = await this.getContentReferences(sha);

      if (references.length > 0) {
        logger().info(
          { sha, referenceCount: references.length },
          'Content still has references, not deleting',
        );
        timer.stop({ has_references: 'true' });
        return false;
      }

      // Delete content from Silo
      const response = await this.env.SILO.fetch(`http://silo/blobs/${metadata.r2Key}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(
          `Failed to delete content from Silo: ${response.status} ${response.statusText}`,
        );
      }

      // Delete metadata from database
      await this.env.DB.prepare(
        `
        DELETE FROM content_blobs
        WHERE sha = ?
      `,
      )
        .bind(sha)
        .run();

      logger().info({ sha }, 'Deleted content from Silo');
      metrics.counter('content_service.content_deleted', 1);

      timer.stop({ deleted: 'true' });
      return true;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to delete content ${sha}`);
      throw error;
    }
  }
}
