import { z } from 'zod';
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
/**
 * Union of all event schemas
 */
export const EventSchema = z.discriminatedUnion('type', [
    ReminderDueEventSchema,
    IngestionCompleteEventSchema,
    RetryEventSchema,
]);
/**
 * Event factory functions
 */
export const createReminderDueEvent = (data) => ({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'reminder_due',
    version: '1.0',
    data,
    attempts: 0,
});
export const createIngestionCompleteEvent = (data) => ({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'ingestion_complete',
    version: '1.0',
    data,
});
export const createRetryEvent = (originalEvent, error, attempts, maxAttempts) => ({
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
//# sourceMappingURL=events.js.map