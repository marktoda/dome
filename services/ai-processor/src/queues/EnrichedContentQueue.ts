import { AbstractQueue } from '@dome/common/queue';
import { EnrichedContentMessage, EnrichedContentMessageSchema } from '@dome/common';

export type { EnrichedContentMessage };

export class EnrichedContentQueue extends AbstractQueue<typeof EnrichedContentMessageSchema> {
  static override schema = EnrichedContentMessageSchema;
}
