import { z } from 'zod';
import crypto from 'node:crypto';

/**
 * Base event schema that all events must extend
 */
export const BaseEventSchema = z.object({
  id: z.string().uuid().optional(),
  timestamp: z
    .string()
    .datetime()
    .default(() => new Date().toISOString()),
  type: z.string(),
  version: z.string().default('1.0'),
});

export type BaseEvent = z.infer<typeof BaseEventSchema>;

/**
 * Reminder due event schema
 */
export const ReminderDueEventSchema = BaseEventSchema.extend({
  type: z.literal('reminder_due'),
  data: z.object({
    reminderId: z.string().uuid(),
    taskId: z.string().uuid(),
    userId: z.string().uuid(),
    title: z.string(),
    description: z.string().optional(),
    dueAt: z.string().datetime(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
  }),
  attempts: z.number().default(0),
});

export type ReminderDueEvent = z.infer<typeof ReminderDueEventSchema>;

/**
 * Ingestion complete event schema
 */
export const IngestionCompleteEventSchema = BaseEventSchema.extend({
  type: z.literal('ingestion_complete'),
  data: z.object({
    noteId: z.string().uuid(),
    userId: z.string().uuid(),
    title: z.string(),
    contentPreview: z.string().max(100).optional(),
    fileType: z.string().optional(),
    fileSize: z.number().optional(),
  }),
});

export type IngestionCompleteEvent = z.infer<typeof IngestionCompleteEventSchema>;

/**
 * Retry event schema for failed events
 */
export const RetryEventSchema = BaseEventSchema.extend({
  type: z.literal('retry'),
  data: z.object({
    originalEvent: z.any(),
    error: z.string(),
    attempts: z.number(),
    maxAttempts: z.number(),
  }),
});

export type RetryEvent = z.infer<typeof RetryEventSchema>;

/**
 * Union of all event schemas
 */
export const EventSchema = z.discriminatedUnion('type', [
  ReminderDueEventSchema,
  IngestionCompleteEventSchema,
  RetryEventSchema,
]);

export type Event = z.infer<typeof EventSchema>;

/**
 * Event factory functions
 */
export const createReminderDueEvent = (
  data: ReminderDueEvent['data'],
): ReminderDueEvent => ({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  type: 'reminder_due',
  version: '1.0',
  data,
  attempts: 0,
});

export const createIngestionCompleteEvent = (
  data: IngestionCompleteEvent['data'],
): IngestionCompleteEvent => ({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  type: 'ingestion_complete',
  version: '1.0',
  data,
});

export const createRetryEvent = (
  originalEvent: any,
  error: string,
  attempts: number,
  maxAttempts: number,
): RetryEvent => ({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  type: 'retry',
  version: '1.0',
  data: {
    originalEvent,
    error,
    attempts,
    maxAttempts,
  },
});
