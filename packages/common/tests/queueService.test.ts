import { describe, it, expect, vi } from 'vitest';
import { QueueService } from '../src/services/queueService';
import { createIngestionCompleteEvent } from '../src/types/events';
import { serializeQueueMessage } from '../src/queue';
import { EventSchema } from '../src/types/events';

const makeQueue = () => ({ send: vi.fn() });

describe('QueueService.publishEvent', () => {
  it('serializes and sends a valid event', async () => {
    const q = makeQueue();
    const svc = new QueueService({ queueBinding: q as any });
    const event = createIngestionCompleteEvent({
      noteId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      title: 't',
      contentPreview: 'p',
    });
    await svc.publishEvent(event);
    expect(q.send).toHaveBeenCalledWith(
      serializeQueueMessage(EventSchema, event),
    );
  });

  it('throws on invalid event', async () => {
    const q = makeQueue();
    const svc = new QueueService({ queueBinding: q as any });
    const bad: any = { type: 'ingestion_complete' };
    await expect(svc.publishEvent(bad)).rejects.toThrow();
    expect(q.send).not.toHaveBeenCalled();
  });
});
