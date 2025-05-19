import { describe, it, expect } from 'vitest';
import { withContext, getRequestId, getIdentity, updateContext } from '../src/context/withContext';
import { baseLogger } from '../src/logging/base';

describe('withContext and updateContext', () => {
  it('provides and updates async context', async () => {
    const result = await withContext({ requestId: 'id1', identity: { userId: 'u1' }, logger: baseLogger }, async () => {
      expect(getRequestId()).toBe('id1');
      expect(getIdentity().userId).toBe('u1');
      await updateContext({ identity: { userId: 'u2' } });
      return getIdentity().userId;
    });
    expect(result).toBe('u2');
  });
});
