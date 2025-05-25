import { describe, it, expect, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));

import AiProcessor from '../src/index';
import { MessageBatch } from '@dome/common';
import type { NewContentMessage } from '@dome/common';

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
    const msg: NewContentMessage = { id: '1', userId: 'u' };
    const batch: MessageBatch<NewContentMessage> = {
      queue: 'test',
      messages: [
        { id: 'm1', timestamp: new Date(), body: msg },
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
    const batch: MessageBatch<unknown> = {
      queue: 'test',
      messages: [
        { id: 'm1', timestamp: new Date(), body: {} },
      ],
    };
    await expect(worker.queue(batch as any)).rejects.toThrow();
    expect(worker._services.processor.processMessage).not.toHaveBeenCalled();
  });
});
