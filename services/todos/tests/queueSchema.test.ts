import { describe, it, expect } from 'vitest';
import { TodoQueueItemSchema } from '../src/types';
import { parseMessageBatch, RawMessageBatch, MessageProcessingError } from '@dome/common';

const validItem = {
  userId: 'u',
  sourceNoteId: 'n',
  sourceText: 'text',
  title: 't',
};

describe('TodoQueueItemSchema', () => {
  it('parses a valid batch', () => {
    const batch: RawMessageBatch = {
      queue: 'todos',
      messages: [
        { id: '1', timestamp: 1, body: JSON.stringify(validItem) },
      ],
    };
    const parsed = parseMessageBatch(TodoQueueItemSchema, batch);
    expect(parsed.messages[0].body.userId).toBe('u');
  });

  it('throws on invalid message', () => {
    const batch: RawMessageBatch = {
      queue: 'todos',
      messages: [
        { id: '1', timestamp: 1, body: JSON.stringify({ userId: 'u' }) },
      ],
    };
    expect(() => parseMessageBatch(TodoQueueItemSchema, batch)).toThrow(MessageProcessingError);
  });
});
