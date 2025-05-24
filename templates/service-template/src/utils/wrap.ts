import { getLogger, trackOperation } from '@dome/common';
import { toDomeError } from './errors';

const logger = getLogger().child({ service: '{{SERVICE_NAME}}' });

/**
 * Wraps service operations with consistent error handling and logging
 */
export async function wrap<T>(
  operation: {
    operation: string;
    userId?: string;
    sessionId?: string;
    [key: string]: any;
  },
  fn: () => Promise<T>
): Promise<T> {
  return trackOperation(
    {
      service: '{{SERVICE_NAME}}',
      ...operation,
    },
    async () => {
      try {
        logger.info('Starting operation', operation);
        const result = await fn();
        logger.info('Operation completed successfully', operation);
        return result;
      } catch (error) {
        logger.error('Operation failed', { ...operation, error });
        throw toDomeError(error);
      }
    }
  );
}