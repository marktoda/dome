import { z } from 'zod';
import { AbstractQueue } from '@dome/common/queue';
import type { DLQMessage } from '../types';

export const DLQMessageSchema = z.object({
  originalMessage: z.any(),
  error: z.object({
    message: z.string(),
    name: z.string(),
    stack: z.string().optional(),
  }),
  processingMetadata: z.object({
    failedAt: z.number(),
    retryCount: z.number(),
    queueName: z.string(),
    messageId: z.string(),
    producerService: z.string().optional(),
  }),
  recovery: z.object({
    reprocessed: z.boolean(),
    reprocessedAt: z.number().optional(),
    recoveryResult: z.string().optional(),
  }),
});

export type IngestDlqMessage = DLQMessage<unknown>;

export class IngestDlqQueue extends AbstractQueue<typeof DLQMessageSchema> {
  static override schema = DLQMessageSchema;
}
