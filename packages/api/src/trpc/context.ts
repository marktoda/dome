import { createLogger } from '@dome2/shared/logger';

// tRPC context interface
export interface TRPCContext {
  req: Request;
  user?: {
    id: string;
    orgId: string;
    permissions: string[];
  };
  apiKey?: {
    id: string;
    orgId: string;
    permissions: string[];
    rateLimit: number;
  };
  logger: ReturnType<typeof createLogger>;
}

// Create context function
export const createTRPCContext = async ({ req }: { req: Request }): Promise<TRPCContext> => {
  const logger = createLogger('trpc');

  // Extract authentication from headers
  const authHeader = req.headers.get('authorization');
  const apiKeyHeader = req.headers.get('x-api-key');

  let user: TRPCContext['user'];
  let apiKey: TRPCContext['apiKey'];

  // TODO: Implement actual authentication logic
  // For now, we'll set up the structure

  if (authHeader?.startsWith('Bearer ')) {
    // JWT token authentication
    const token = authHeader.slice(7);
    // TODO: Verify JWT and extract user info
    logger.debug('JWT authentication detected', { hasToken: !!token });
  }

  if (apiKeyHeader) {
    // API key authentication
    // TODO: Verify API key and extract permissions
    logger.debug('API key authentication detected', { hasApiKey: !!apiKeyHeader });
  }

  return {
    req,
    user,
    apiKey,
    logger,
  };
};
