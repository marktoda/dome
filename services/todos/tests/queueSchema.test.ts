import { describe, it, expect } from 'vitest';
import { MessageBatch, MessageProcessingError } from '@dome/common';
import { TodoQueue } from '../src/queues/TodoQueue';

const validItem = {
  userId: 'u',
  sourceNoteId: 'n',
  sourceText: 'text',
  title: 't',
};

describe('TodoQueueItemSchema', () => {
  it('parses a valid batch', () => {
    const batch: MessageBatch<string> = {
      queue: 'todos',
      messages: [
        { id: '1', timestamp: new Date(1), body: JSON.stringify(validItem) },
      ],
    };
    const parsed = TodoQueue.parseBatch(batch);
    expect(parsed.messages[0].body.userId).toBe('u');
  });

  it('throws on invalid message', () => {
    const batch: MessageBatch<string> = {
      queue: 'todos',
      messages: [
        { id: '1', timestamp: new Date(1), body: JSON.stringify({ userId: 'u' }) },
      ],
    };
    expect(() => TodoQueue.parseBatch(batch)).toThrow(MessageProcessingError);
  });
});
