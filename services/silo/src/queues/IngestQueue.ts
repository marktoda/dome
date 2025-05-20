import { AbstractQueue } from '@dome/common/queue';
import { siloSimplePutSchema } from '@dome/common';
import { z } from 'zod';

export type IngestMessage = z.infer<typeof siloSimplePutSchema>;

export class IngestQueue extends AbstractQueue<typeof siloSimplePutSchema> {
  static override schema = siloSimplePutSchema;
}
