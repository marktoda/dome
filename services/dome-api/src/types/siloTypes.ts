/**
 * Type definitions for Silo service data models
 * These types represent the data structures used by the Silo service
 */

/**
 * Content metadata structure in Silo service
 */
export interface SiloContentMetadata {
  id: string;
  userId: string | null;
  contentType: string;
  size: number;
  r2Key: string;
  sha256?: string;
  createdAt: number;
  version: number;
}

/**
 * Simple content put request structure
 */
export interface SiloSimplePutRequest {
  id?: string;
  userId?: string;
  content: string | ArrayBuffer;
  contentType: string;
  metadata?: Record<string, any>;
  acl?: { public?: boolean };
}

/**
 * Simple content put response structure
 */
export interface SiloSimplePutResponse {
  id: string;
  contentType: string;
  size: number;
  createdAt: number;
}

/**
 * Upload creation request structure
 */
export interface SiloCreateUploadRequest {
  contentType: string;
  size: number;
  metadata?: Record<string, any>;
  acl?: { public?: boolean };
  expirationSeconds?: number;
  sha256?: string;
  userId?: string;
}

/**
 * Upload creation response structure
 */
export interface SiloCreateUploadResponse {
  id: string;
  uploadUrl: string;
  formData: Record<string, string>;
  expiresIn: number;
}

/**
 * Batch get request structure
 */
export interface SiloBatchGetRequest {
  ids: string[];
  userId?: string | null;
}

/**
 * Batch get response structure
 */
export interface SiloBatchGetResponse {
  items: SiloBatchGetItem[];
}

/**
 * Batch get item structure
 */
export interface SiloBatchGetItem {
  id: string;
  userId: string | null;
  contentType: string;
  size: number;
  createdAt: number;
  body?: string;
  url?: string;
}

/**
 * Delete request structure
 */
export interface SiloDeleteRequest {
  id: string;
  userId?: string | null;
}

/**
 * Delete response structure
 */
export interface SiloDeleteResponse {
  success: boolean;
}

/**
 * Stats response structure
 */
export interface SiloStatsResponse {
  totalObjects: number;
  totalSize: number;
  objectsByContentType: Record<string, number>;
  objectsByUser: Record<string, number>;
}

/**
 * R2 Event structure for object-created events
 */
export interface SiloR2Event {
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
