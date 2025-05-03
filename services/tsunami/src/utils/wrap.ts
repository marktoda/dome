import { withContext, logError } from '@dome/common';

export const wrap = <T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  withContext(Object.assign({ service: 'tsunami' }, meta), async () => {
    try {
      return await fn();
    } catch (err) {
      logError(err, 'Unhandled error');
      throw err;
    }
  });
