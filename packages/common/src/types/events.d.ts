import { z } from 'zod';
/**
 * Base event schema that all events must extend
 */
export declare const BaseEventSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    type: z.ZodString;
    version: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    timestamp: string;
    type: string;
    version: string;
    id?: string | undefined;
}, {
    type: string;
    id?: string | undefined;
    timestamp?: string | undefined;
    version?: string | undefined;
}>;
export type BaseEvent = z.infer<typeof BaseEventSchema>;
/**
 * Reminder due event schema
 */
export declare const ReminderDueEventSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    version: z.ZodDefault<z.ZodString>;
    type: z.ZodLiteral<"reminder_due">;
    data: z.ZodObject<{
        reminderId: z.ZodString;
        taskId: z.ZodString;
        userId: z.ZodString;
        title: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        dueAt: z.ZodString;
        priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    }, "strip", z.ZodTypeAny, {
        reminderId: string;
        taskId: string;
        userId: string;
        title: string;
        dueAt: string;
        description?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
    }, {
        reminderId: string;
        taskId: string;
        userId: string;
        title: string;
        dueAt: string;
        description?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
    }>;
    attempts: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    timestamp: string;
    type: "reminder_due";
    version: string;
    data: {
        reminderId: string;
        taskId: string;
        userId: string;
        title: string;
        dueAt: string;
        description?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
    };
    attempts: number;
    id?: string | undefined;
}, {
    type: "reminder_due";
    data: {
        reminderId: string;
        taskId: string;
        userId: string;
        title: string;
        dueAt: string;
        description?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
    };
    id?: string | undefined;
    timestamp?: string | undefined;
    version?: string | undefined;
    attempts?: number | undefined;
}>;
export type ReminderDueEvent = z.infer<typeof ReminderDueEventSchema>;
/**
 * Ingestion complete event schema
 */
export declare const IngestionCompleteEventSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    version: z.ZodDefault<z.ZodString>;
    type: z.ZodLiteral<"ingestion_complete">;
    data: z.ZodObject<{
        noteId: z.ZodString;
        userId: z.ZodString;
        title: z.ZodString;
        contentPreview: z.ZodOptional<z.ZodString>;
        fileType: z.ZodOptional<z.ZodString>;
        fileSize: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        userId: string;
        title: string;
        noteId: string;
        contentPreview?: string | undefined;
        fileType?: string | undefined;
        fileSize?: number | undefined;
    }, {
        userId: string;
        title: string;
        noteId: string;
        contentPreview?: string | undefined;
        fileType?: string | undefined;
        fileSize?: number | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    timestamp: string;
    type: "ingestion_complete";
    version: string;
    data: {
        userId: string;
        title: string;
        noteId: string;
        contentPreview?: string | undefined;
        fileType?: string | undefined;
        fileSize?: number | undefined;
    };
    id?: string | undefined;
}, {
    type: "ingestion_complete";
    data: {
        userId: string;
        title: string;
        noteId: string;
        contentPreview?: string | undefined;
        fileType?: string | undefined;
        fileSize?: number | undefined;
    };
    id?: string | undefined;
    timestamp?: string | undefined;
    version?: string | undefined;
}>;
export type IngestionCompleteEvent = z.infer<typeof IngestionCompleteEventSchema>;
/**
 * Retry event schema for failed events
 */
export declare const RetryEventSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    version: z.ZodDefault<z.ZodString>;
    type: z.ZodLiteral<"retry">;
    data: z.ZodObject<{
        originalEvent: z.ZodAny;
        error: z.ZodString;
        attempts: z.ZodNumber;
        maxAttempts: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        error: string;
        attempts: number;
        maxAttempts: number;
        originalEvent?: any;
    }, {
        error: string;
        attempts: number;
        maxAttempts: number;
        originalEvent?: any;
    }>;
}, "strip", z.ZodTypeAny, {
    timestamp: string;
    type: "retry";
    version: string;
    data: {
        error: string;
        attempts: number;
        maxAttempts: number;
        originalEvent?: any;
    };
    id?: string | undefined;
}, {
    type: "retry";
    data: {
        error: string;
        attempts: number;
        maxAttempts: number;
        originalEvent?: any;
    };
    id?: string | undefined;
    timestamp?: string | undefined;
    version?: string | undefined;
}>;
export type RetryEvent = z.infer<typeof RetryEventSchema>;
/**
 * Union of all event schemas
 */
export declare const EventSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    version: z.ZodDefault<z.ZodString>;
    type: z.ZodLiteral<"reminder_due">;
    data: z.ZodObject<{
        reminderId: z.ZodString;
        taskId: z.ZodString;
        userId: z.ZodString;
        title: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        dueAt: z.ZodString;
        priority: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    }, "strip", z.ZodTypeAny, {
        reminderId: string;
        taskId: string;
        userId: string;
        title: string;
        dueAt: string;
        description?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
    }, {
        reminderId: string;
        taskId: string;
        userId: string;
        title: string;
        dueAt: string;
        description?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
    }>;
    attempts: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    timestamp: string;
    type: "reminder_due";
    version: string;
    data: {
        reminderId: string;
        taskId: string;
        userId: string;
        title: string;
        dueAt: string;
        description?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
    };
    attempts: number;
    id?: string | undefined;
}, {
    type: "reminder_due";
    data: {
        reminderId: string;
        taskId: string;
        userId: string;
        title: string;
        dueAt: string;
        description?: string | undefined;
        priority?: "low" | "medium" | "high" | undefined;
    };
    id?: string | undefined;
    timestamp?: string | undefined;
    version?: string | undefined;
    attempts?: number | undefined;
}>, z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    version: z.ZodDefault<z.ZodString>;
    type: z.ZodLiteral<"ingestion_complete">;
    data: z.ZodObject<{
        noteId: z.ZodString;
        userId: z.ZodString;
        title: z.ZodString;
        contentPreview: z.ZodOptional<z.ZodString>;
        fileType: z.ZodOptional<z.ZodString>;
        fileSize: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        userId: string;
        title: string;
        noteId: string;
        contentPreview?: string | undefined;
        fileType?: string | undefined;
        fileSize?: number | undefined;
    }, {
        userId: string;
        title: string;
        noteId: string;
        contentPreview?: string | undefined;
        fileType?: string | undefined;
        fileSize?: number | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    timestamp: string;
    type: "ingestion_complete";
    version: string;
    data: {
        userId: string;
        title: string;
        noteId: string;
        contentPreview?: string | undefined;
        fileType?: string | undefined;
        fileSize?: number | undefined;
    };
    id?: string | undefined;
}, {
    type: "ingestion_complete";
    data: {
        userId: string;
        title: string;
        noteId: string;
        contentPreview?: string | undefined;
        fileType?: string | undefined;
        fileSize?: number | undefined;
    };
    id?: string | undefined;
    timestamp?: string | undefined;
    version?: string | undefined;
}>, z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodDefault<z.ZodString>;
    version: z.ZodDefault<z.ZodString>;
    type: z.ZodLiteral<"retry">;
    data: z.ZodObject<{
        originalEvent: z.ZodAny;
        error: z.ZodString;
        attempts: z.ZodNumber;
        maxAttempts: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        error: string;
        attempts: number;
        maxAttempts: number;
        originalEvent?: any;
    }, {
        error: string;
        attempts: number;
        maxAttempts: number;
        originalEvent?: any;
    }>;
}, "strip", z.ZodTypeAny, {
    timestamp: string;
    type: "retry";
    version: string;
    data: {
        error: string;
        attempts: number;
        maxAttempts: number;
        originalEvent?: any;
    };
    id?: string | undefined;
}, {
    type: "retry";
    data: {
        error: string;
        attempts: number;
        maxAttempts: number;
        originalEvent?: any;
    };
    id?: string | undefined;
    timestamp?: string | undefined;
    version?: string | undefined;
}>]>;
export type Event = z.infer<typeof EventSchema>;
/**
 * Event factory functions
 */
export declare const createReminderDueEvent: (data: ReminderDueEvent["data"]) => ReminderDueEvent;
export declare const createIngestionCompleteEvent: (data: IngestionCompleteEvent["data"]) => IngestionCompleteEvent;
export declare const createRetryEvent: (originalEvent: any, error: string, attempts: number, maxAttempts: number) => RetryEvent;
