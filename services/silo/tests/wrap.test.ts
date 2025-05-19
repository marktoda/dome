import { describe, it, expect, vi } from 'vitest';

vi.mock('@dome/common', () => ({
  createServiceWrapper: vi.fn(() => async (_meta: any, fn: () => Promise<any>) => fn()),
}));

import { wrap } from '../src/utils/wrap';
import { createServiceWrapper } from '@dome/common';

describe('wrap utility', () => {
  it('delegates to createServiceWrapper with silo context', async () => {
    const fn = vi.fn(async () => 42);
    const result = await wrap({ operation: 'test' }, fn);
    expect(result).toBe(42);
    expect(createServiceWrapper).toHaveBeenCalledWith('silo');
  });
});
