import { describe, it, expect, vi } from 'vitest';
import { sendTodosToQueue } from '../src/todos';
import { PUBLIC_USER_ID } from '@dome/common';

const makeQueue = () => ({ send: vi.fn() });

const baseContent = {
  id: '1',
  userId: 'u1',
  category: 'note',
  mimeType: 'text/plain',
  metadata: {
    todos: [{ text: 'a' }],
    processingVersion: 1,
    modelUsed: 'm',
    title: 't',
  },
  timestamp: Date.now(),
};

describe('sendTodosToQueue', () => {
  it('sends todos when userId present', async () => {
    const q = makeQueue();
    await sendTodosToQueue(baseContent as any, q as any);
    expect(q.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(q.send.mock.calls[0][0]);
    expect(sent).toMatchObject({ userId: 'u1', description: 'a' });
  });

  it('skips when no userId', async () => {
    const q = makeQueue();
    await sendTodosToQueue({ ...baseContent, userId: null } as any, q as any);
    expect(q.send).not.toHaveBeenCalled();
  });

  it('skips public user', async () => {
    const q = makeQueue();
    await sendTodosToQueue({ ...baseContent, userId: PUBLIC_USER_ID } as any, q as any);
    expect(q.send).not.toHaveBeenCalled();
  });
});
