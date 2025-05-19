import { z } from 'zod';
import { AbstractQueue } from '@dome/common/queue';
import { EmbedDeadLetterMessageSchema } from '@dome/common';

/**
 * Type definition for messages from Zod schema
 */
export type DeadLetterMessage = z.infer<typeof EmbedDeadLetterMessageSchema>;

/**
 * Type-safe wrapper for the dead letter queue.
 * Uses the existing EmbedDeadLetterMessageSchema from common.
 */
export class DeadLetterQueue extends AbstractQueue<DeadLetterMessage, typeof EmbedDeadLetterMessageSchema> {
  protected readonly schema = EmbedDeadLetterMessageSchema;
} 