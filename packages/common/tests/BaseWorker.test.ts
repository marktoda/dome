import { describe, it, expect, vi } from 'vitest';
import { BaseWorker } from '../src/service/BaseWorker';

vi.mock('../src/utils/functionWrapper', async () => {
  const actual = await vi.importActual<any>('../src/utils/functionWrapper');
  return {
    ...actual,
    createServiceWrapper: vi.fn(() => async (_m: any, fn: () => Promise<any>) => fn()),
  };
});

import { createServiceWrapper } from '../src/utils/functionWrapper';

class TestWorker extends BaseWorker<any, Record<string, any>> {
  public getServices() {
    return this.services;
  }
}

describe('BaseWorker', () => {
  it('creates services lazily', () => {
    const build = vi.fn(() => ({ a: 1 }));
    const worker = new TestWorker({}, {}, build, { serviceName: 'test' });

    expect(build).not.toHaveBeenCalled();
    const s1 = worker.getServices();
    expect(build).toHaveBeenCalledTimes(1);
    const s2 = worker.getServices();
    expect(build).toHaveBeenCalledTimes(1);
    expect(s1).toBe(s2);
  });

  it('wrap delegates to createServiceWrapper', async () => {
    const wrapperFn = vi.fn(async (_m: any, fn: () => Promise<any>) => fn());
    (createServiceWrapper as unknown as vi.Mock).mockReturnValue(wrapperFn);

    const worker = new TestWorker({}, {}, () => ({}), { serviceName: 'test' });
    const result = await worker.wrap({ op: 'test' }, async () => 123);

    expect(wrapperFn).toHaveBeenCalledWith({ op: 'test' }, expect.any(Function));
    expect(result).toBe(123);
  });
});
