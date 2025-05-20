import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewContentQueue } from '../src/queues/NewContentQueue';
import { NewContentMessageSchema } from '@dome/common';
import * as queueHelpers from '@dome/common/queue';

const mockQueue = { send: vi.fn() };

const validMessage = { id: '1', userId: 'u' };

describe('NewContentQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes messages using the schema', async () => {
    const queue = new NewContentQueue(mockQueue as any);
    const spy = vi.spyOn(queueHelpers, 'serializeQueueMessage');
    await queue.send(validMessage);
    expect(spy).toHaveBeenCalledWith(NewContentMessageSchema, validMessage);
    expect(mockQueue.send).toHaveBeenCalledTimes(1);
  });

  it('parses a batch', () => {
    const batch: queueHelpers.MessageBatch<string> = {
      queue: 'test',
      messages: [
        {
          id: 'a',
          timestamp: new Date(1),
          body: JSON.stringify(validMessage),
        },
      ],
    };

    const parsed = NewContentQueue.parseBatch(batch);
    expect(parsed.messages[0].body).toEqual(validMessage);
  });
});
