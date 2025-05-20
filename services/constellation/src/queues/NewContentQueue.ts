import { AbstractQueue } from '@dome/common/queue';
import { NewContentMessage, NewContentMessageSchema } from '@dome/common';

export type { NewContentMessage };

export class NewContentQueue extends AbstractQueue<NewContentMessage, typeof NewContentMessageSchema> {
  public static schema = NewContentMessageSchema;
}
