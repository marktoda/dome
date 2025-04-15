/**
 * Type definitions for Telegram entities
 */

/**
 * Telegram user information
 */
export interface TelegramUser {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string;
  photo?: any;
  status?: any;
  bot?: boolean;
  verified?: boolean;
  restricted?: boolean;
  scam?: boolean;
  fake?: boolean;
  accessHash?: string;
}

/**
 * Telegram chat information
 */
export interface TelegramChat {
  id: number;
  title?: string;
  username?: string;
  photo?: any;
  participantsCount?: number;
  date?: number;
  version?: number;
  creator?: boolean;
  left?: boolean;
  broadcast?: boolean;
  verified?: boolean;
  megagroup?: boolean;
  restricted?: boolean;
  scam?: boolean;
  fake?: boolean;
  accessHash?: string;
}

/**
 * Telegram message
 */
export interface TelegramMessage {
  id: number;
  peerId?: number;
  fromId?: number;
  message?: string;
  date?: number;
  fwdFrom?: any;
  viaBotId?: number;
  replyToMsgId?: number;
  entities?: any[];
  media?: any;
  replyMarkup?: any;
  views?: number;
  editDate?: number;
  postAuthor?: string;
  groupedId?: string;
  reactions?: any[];
  restrictionReason?: string[];
  forwards?: number;
  replies?: any;
  action?: any;
  ttlPeriod?: number;
}

/**
 * Authentication code response
 */
export interface AuthSendCodeResult {
  phoneCodeHash: string;
  timeout: number;
  isCodeViaApp: boolean;
}

/**
 * Authentication verification result
 */
export interface AuthVerificationResult {
  user: TelegramUser;
  sessionData: {
    authKey: string;
    userId: string;
  };
}

/**
 * Chat list result
 */
export interface ChatListResult {
  chats: TelegramChat[];
  users: TelegramUser[];
  count: number;
}

/**
 * Message list result
 */
export interface MessageListResult {
  messages: TelegramMessage[];
  users: TelegramUser[];
  chats: TelegramChat[];
  count: number;
}

/**
 * Send message result
 */
export interface SendMessageResult {
  message: TelegramMessage;
  users: TelegramUser[];
  chats: TelegramChat[];
}