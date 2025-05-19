import { describe, it, expect } from 'vitest';
import { NewContentMessageSchema } from '../src/types/queueMessages';
import {
  parseQueueMessage,
  parseMessageBatch,
  serializeQueueMessage,
  RawMessageBatch,
  toRawMessageBatch,
} from '../src/queue';
import { MessageProcessingError } from '../src/errors/ServiceError';

const validMessage = {
  id: '1',
  userId: 'u',
  category: 'note',
};

describe('queue message helpers', () => {
  it('serializes and parses a message', () => {
    const str = serializeQueueMessage(NewContentMessageSchema, validMessage);
    const parsed = parseQueueMessage(NewContentMessageSchema, str);
    expect(parsed).toEqual({ id: '1', userId: 'u', category: 'note' });
  });

  it('fails serialization when the message does not match the schema', () => {
    const bad = { ...validMessage, id: '' };
    expect(() =>
      serializeQueueMessage(NewContentMessageSchema, bad as any)
    ).toThrow(MessageProcessingError);
  });

  it('parses a batch', () => {
    const batch: RawMessageBatch = {
      queue: 'test',
      messages: [
        { id: 'a', timestamp: 1, body: JSON.stringify(validMessage) },
        { id: 'b', timestamp: 2, body: JSON.stringify({ id: '2', userId: null }) },
      ],
    };
    const parsed = parseMessageBatch(NewContentMessageSchema, batch);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].body).toEqual(validMessage);
    expect(parsed.messages[1].body).toEqual({ id: '2', userId: null });
  });

  it('throws when parsing invalid JSON', () => {
    expect(() =>
      parseQueueMessage(NewContentMessageSchema, '{foo:')
    ).toThrow(MessageProcessingError);
  });

  it('throws when a message fails validation', () => {
    const invalid = JSON.stringify({ id: '' });
    expect(() =>
      parseQueueMessage(NewContentMessageSchema, invalid)
    ).toThrow(MessageProcessingError);
  });

  it('throws when a batch message is invalid', () => {
    const batch: RawMessageBatch = {
      queue: 'test',
      messages: [
        { id: 'a', timestamp: 1, body: JSON.stringify(validMessage) },
        { id: 'b', timestamp: 2, body: JSON.stringify({ id: '' }) },
      ],
    };
    expect(() => parseMessageBatch(NewContentMessageSchema, batch)).toThrow(
      MessageProcessingError
    );
  });

  it('converts a MessageBatch to raw format', () => {
    const msg = {
      id: 'a',
      timestamp: new Date(1),
      body: JSON.stringify(validMessage),
      attempts: 0,
      retry() {},
      ack() {},
    };
    const batch: MessageBatch<string> = {
      queue: 'test',
      messages: [msg],
      retryAll() {},
      ackAll() {},
    };

    const raw = toRawMessageBatch(batch);
    expect(raw.messages[0].timestamp).toBe(1);
    expect(raw.messages[0].body).toBe(msg.body);
  });
});
