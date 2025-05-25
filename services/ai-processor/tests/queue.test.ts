import { describe, it, expect, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));

// Mock the silo import that doesn't exist
vi.mock('@dome/silo/client', () => ({
  SiloClient: class MockSiloClient {
    constructor() {}
  },
  SiloBinding: {}
}));

vi.mock('@dome/silo/queues', () => ({
  NewContentQueue: {
    parseBatch: vi.fn().mockImplementation((batch) => ({
      queue: batch.queue,
      messages: batch.messages.map(m => ({
        id: m.id,
        timestamp: m.timestamp,
        body: JSON.parse(m.body)
      }))
    }))
  }
}));

import AiProcessor from '../src/index';
import { RawMessageBatch } from '@dome/common';

const makeWorker = () => {
  const worker = new AiProcessor({} as any, {} as any);
  (worker as any)._services = {
    processor: { processMessage: vi.fn() },
  } as any;
  return worker as any;
};

describe('AiProcessor.queue', () => {
  it('parses and processes a valid batch', async () => {
    const worker = makeWorker();
    const msg = { id: '1', userId: 'u' };
    const batch: RawMessageBatch = {
      queue: 'test',
      messages: [
        { id: 'm1', timestamp: Date.now(), body: JSON.stringify(msg) },
      ],
    };
    await worker.queue(batch as any);
    expect(worker._services.processor.processMessage).toHaveBeenCalledWith(
      msg,
      expect.any(String),
    );
  });

  it('throws when batch parsing fails', async () => {
    const worker = makeWorker();
    const batch: RawMessageBatch = {
      queue: 'test',
      messages: [
        { id: 'm1', timestamp: Date.now(), body: JSON.stringify({}) },
      ],
    };
    await expect(worker.queue(batch as any)).rejects.toThrow();
    expect(worker._services.processor.processMessage).not.toHaveBeenCalled();
  });
});
