/**
 * Type definitions for the Silo service
 */

/**
 * R2 Event structure for object-created events
 */
export interface R2Event {
  account: string;
  bucket: string;
  eventTime: string;
  action: string; // "PutObject" for new objects
  object: {
    key: string;
    eTag: string;
    size: number;
  };
}
