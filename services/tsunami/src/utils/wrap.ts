import { withLogger, logError, getLogger } from '@dome/logging';

export const wrap = <T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> =>
  withLogger(Object.assign({ service: 'tsunami' }, meta), async () => {
    try {
      return await fn();
    } catch (err) {
      logError(err, 'Unhandled error');
      throw err;
    }
  });
