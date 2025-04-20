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
