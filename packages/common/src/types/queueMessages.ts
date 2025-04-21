import { z } from 'zod';
import { ContentType } from './siloContent';

/**
 * Schema for messages sent to the new-content queue
 * This is used by both the Silo service (sender) and Constellation service (receiver)
 * to ensure type safety and validation across services.
 */
export const NewContentMessageSchema = z.object({
  // Required fields
  id: z.string().min(1, 'Content ID is required'),
  userId: z.string().nullable(),

  // Optional fields for content creation/update
  contentType: z.string().optional(),
  size: z.number().int().positive().optional(),
  createdAt: z.number().int().optional(),
  metadata: z.union([z.record(z.string(), z.any()), z.null()]).optional(),

  // Optional field for deletion
  deleted: z.boolean().optional(),
});

export type NewContentMessage = z.infer<typeof NewContentMessageSchema>;

/**
 * Schema for messages sent to the embed-dead-letter queue
 * Used when processing a message from the new-content queue fails
 */
export const EmbedDeadLetterMessageSchema = z.object({
  error: z.string(),
  originalMessage: z.any(),
});

export type EmbedDeadLetterMessage = z.infer<typeof EmbedDeadLetterMessageSchema>;
