import { AbstractQueue } from '@dome/common/queue';
import { NewContentMessage, NewContentMessageSchema } from '@dome/common';

export type { NewContentMessage };

export class RateLimitDlqQueue extends AbstractQueue<typeof NewContentMessageSchema> {
  static override schema = NewContentMessageSchema;
}
