/**
 * Message types for the dome project
 */

/**
 * Platform enum for message sources
 */
export enum Platform {
  TELEGRAM = 'telegram',
  EMAIL = 'email',
  SLACK = 'slack',
  WEB = 'web',
  API = 'api',
}

/**
 * Content type for messages
 */
export type MessageContent = {
  type: 'text' | 'image' | 'file' | 'audio' | 'video';
  text?: string;
  url?: string;
  mimeType?: string;
};

/**
 * Metadata for messages
 */
export type MessageMetadata = {
  sender?: {
    id?: string;
    name?: string;
    email?: string;
  };
  tags?: string[];
  [key: string]: any;
};

/**
 * Message data interface
 */
export interface MessageData {
  id: string;
  platform: Platform | string;
  timestamp: number;
  content: MessageContent;
  metadata?: MessageMetadata;
}
