import { SiloBatchGetInput, SiloContentBatch } from '@dome/common';
import { SiloBinding } from '@dome/silo/client';
import { z } from 'zod';

/**
 * Environment interface for AI Processor
 */
export interface ServiceEnv {
  AI: Ai;
  ENRICHED_CONTENT: Queue;
  RATE_LIMIT_DLQ: Queue;
  TODOS: Queue;
  SILO: SiloBinding;
  AI_MODEL_NAME?: string;
  AI_TOKEN_LIMIT?: string;
}


// Define Cloudflare Workers types
export interface GenericQueue<T> {
  send(message: T): Promise<void>;
  sendBatch(messages: T[]): Promise<void>;
}


/**
 * Message batch from queue
 */
export interface MessageBatch<T> {
  queue: string;
  messages: { id: string; body: T; timestamp: number }[];
}

/**
 * Reminder status enum
 */
export enum ReminderStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  SNOOZED = 'snoozed',
  FAILED = 'failed',
}

/**
 * Reminder priority enum
 */
export enum ReminderPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * Notification channel enum
 */
export enum NotificationChannel {
  PUSH = 'push',
  EMAIL = 'email',
  IN_APP = 'in_app',
}

/**
 * Recurrence pattern interface
 */
export interface RecurrencePattern {
  type: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
  interval: number;
  endAfter?: number;
  endDate?: string;
  daysOfWeek?: number[];
  dayOfMonth?: number;
  monthOfYear?: number;
  customExpression?: string;
}

/**
 * Reminder interface
 */
export interface Reminder {
  id: string;
  userId: string;
  title: string;
  description?: string;
  dueAt: string;
  createdAt: string;
  sourceContentId?: string;
  status: ReminderStatus;
  priority: ReminderPriority;
  recurrence?: RecurrencePattern;
  notificationChannels: NotificationChannel[];
  metadata: Record<string, any>;
}

/**
 * Reminder queue message interface
 */
export interface ReminderQueueMessage {
  messageId: string;
  reminderData: Reminder;
  attempts: number;
  timestamp: string;
  priority: number;
  metadata: Record<string, any>;
}

// Define the schema for reprocess requests
export const ReprocessRequestSchema = z.object({
  id: z.string().optional(),
});

// Define the schema for reprocess responses
export const ReprocessResponseSchema = z.object({
  success: z.boolean(),
  reprocessed: z.union([
    z.object({
      id: z.string(),
      success: z.boolean(),
    }),
    z.object({
      total: z.number(),
      successful: z.number(),
    }),
  ]),
});
