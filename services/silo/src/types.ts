/**
 * Type definitions for the Silo service
 */

/**
 * R2 Event structure for object-created events
 */
export interface R2Event {
  type: string;
  time: string;
  eventTime: string;
  object: {
    key: string;
    size: number;
    etag: string;
    httpEtag: string;
  };
}

/**
 * Content metadata structure
 */
export interface ContentMetadata {
  id: string;
  userId: string | null;
  contentType: string;
  size: number;
  r2Key: string;
  sha256?: string;
  createdAt: number;
  version: number;
}

// Use the Cloudflare types for MessageBatch
