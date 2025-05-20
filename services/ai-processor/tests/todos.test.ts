import { describe, it, expect, vi } from 'vitest';
import { sendTodosToQueue } from '../src/todos';
import { PUBLIC_USER_ID } from '@dome/common';
import { TodoQueue } from '../src/queues/TodoQueue';

const makeQueue = () => {
  const binding = { send: vi.fn(), sendBatch: vi.fn() };
  return { wrapper: new TodoQueue(binding as any), binding };
};

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
    const { wrapper, binding } = makeQueue();
    await sendTodosToQueue(baseContent as any, wrapper as any);
    expect(binding.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(binding.send.mock.calls[0][0]);
    expect(sent).toMatchObject({ userId: 'u1', description: 'a' });
  });

  it('skips when no userId', async () => {
    const { wrapper, binding } = makeQueue();
    await sendTodosToQueue({ ...baseContent, userId: null } as any, wrapper as any);
    expect(binding.send).not.toHaveBeenCalled();
  });

  it('skips public user', async () => {
    const { wrapper, binding } = makeQueue();
    await sendTodosToQueue({ ...baseContent, userId: PUBLIC_USER_ID } as any, wrapper as any);
    expect(binding.send).not.toHaveBeenCalled();
  });
});
