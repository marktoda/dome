/**
 * Extended error interface with additional properties
 */
export interface ExtendedError {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, any>;
}