import { Bindings } from '../types';
import { ServiceError } from '@dome/common';

/**
 * Interface for R2 object metadata
 */
export interface R2ObjectMetadata {
  contentType: string;
  size: number;
  etag: string;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

/**
 * Service for interacting with Cloudflare R2
 */
export class R2Service {
  /**
   * Upload an object to R2
   * @param env Environment bindings
   * @param key Object key
   * @param data Object data
   * @param contentType Content type
   * @param metadata Custom metadata
   * @returns Promise with the uploaded object's metadata
   */
  async uploadObject(
    env: Bindings,
    key: string,
    data: ReadableStream | ArrayBuffer | string,
    contentType: string,
    metadata?: Record<string, string>
  ): Promise<R2ObjectMetadata> {
    try {
      const r2 = env.RAW;
      
      const options: R2PutOptions = {
        httpMetadata: {
          contentType
        }
      };
      
      if (metadata) {
        options.customMetadata = metadata;
      }
      
      const object = await r2.put(key, data, options);
      
      if (!object) {
        throw new Error(`Failed to upload object with key ${key}`);
      }
      
      return {
        contentType,
        size: object.size,
        etag: object.etag,
        uploaded: object.uploaded,
        customMetadata: metadata
      };
    } catch (error) {
      console.error(`Error uploading object to R2 with key ${key}:`, error);
      throw new ServiceError(`Failed to upload object to R2 with key ${key}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { key, contentType }
      });
    }
  }
  
  /**
   * Download an object from R2
   * @param env Environment bindings
   * @param key Object key
   * @returns Promise with the object data and metadata
   */
  async downloadObject(env: Bindings, key: string): Promise<{ data: ReadableStream; metadata: R2ObjectMetadata } | null> {
    try {
      const r2 = env.RAW;
      const object = await r2.get(key);
      
      if (!object) {
        return null;
      }
      
      const metadata: R2ObjectMetadata = {
        contentType: object.httpMetadata?.contentType || 'application/octet-stream',
        size: object.size,
        etag: object.etag,
        uploaded: object.uploaded,
        customMetadata: object.customMetadata
      };
      
      return {
        data: object.body,
        metadata
      };
    } catch (error) {
      console.error(`Error downloading object from R2 with key ${key}:`, error);
      throw new ServiceError(`Failed to download object from R2 with key ${key}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { key }
      });
    }
  }
  
  /**
   * Delete an object from R2
   * @param env Environment bindings
   * @param key Object key
   * @returns Promise<boolean> True if deleted, false if not found
   */
  async deleteObject(env: Bindings, key: string): Promise<boolean> {
    try {
      const r2 = env.RAW;
      
      // Check if object exists before deleting
      const exists = await r2.get(key);
      if (!exists) {
        return false;
      }
      
      await r2.delete(key);
      return true;
    } catch (error) {
      console.error(`Error deleting object from R2 with key ${key}:`, error);
      throw new ServiceError(`Failed to delete object from R2 with key ${key}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { key }
      });
    }
  }
  
  /**
   * Check if an object exists in R2
   * @param env Environment bindings
   * @param key Object key
   * @returns Promise<boolean> True if exists, false if not
   */
  async objectExists(env: Bindings, key: string): Promise<boolean> {
    try {
      const r2 = env.RAW;
      const object = await r2.get(key);
      return object !== null;
    } catch (error) {
      console.error(`Error checking if object exists in R2 with key ${key}:`, error);
      throw new ServiceError(`Failed to check if object exists in R2 with key ${key}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { key }
      });
    }
  }
  
  // Note: Signed URLs are not directly supported in the R2Bucket interface
  // These would need to be implemented using a custom solution or Workers R2 API
}

// Export singleton instance
export const r2Service = new R2Service();