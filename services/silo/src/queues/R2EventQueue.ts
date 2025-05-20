import { z } from 'zod';
import { AbstractQueue } from '@dome/common/queue';
import type { R2Event } from '../types';

export const R2EventSchema = z.object({
  account: z.string(),
  bucket: z.string(),
  eventTime: z.string(),
  action: z.string(),
  object: z.object({
    key: z.string(),
    eTag: z.string(),
    size: z.number(),
  }),
});

export type { R2Event };

export class R2EventQueue extends AbstractQueue<typeof R2EventSchema> {
  static override schema = R2EventSchema;
}
