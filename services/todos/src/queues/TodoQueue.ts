import { AbstractQueue } from '@dome/common/queue';
import { TodoQueueItem, TodoQueueItemSchema } from '../types';

export type { TodoQueueItem };

export class TodoQueue extends AbstractQueue<typeof TodoQueueItemSchema> {
  static override schema = TodoQueueItemSchema;
}
