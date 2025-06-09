import { TRPCError, initTRPC } from '@trpc/server';

import type { TRPCContext } from './context.js';

// Initialize tRPC
const t = initTRPC.context<TRPCContext>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        code: error.code,
        httpStatus: getHTTPStatusCodeFromError(error),
      },
    };
  },
});

// Helper to map tRPC errors to HTTP status codes
function getHTTPStatusCodeFromError(error: TRPCError): number {
  switch (error.code) {
    case 'PARSE_ERROR':
      return 400;
    case 'BAD_REQUEST':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'METHOD_NOT_SUPPORTED':
      return 405;
    case 'TIMEOUT':
      return 408;
    case 'CONFLICT':
      return 409;
    case 'PRECONDITION_FAILED':
      return 412;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'UNPROCESSABLE_CONTENT':
      return 422;
    case 'TOO_MANY_REQUESTS':
      return 429;
    case 'CLIENT_CLOSED_REQUEST':
      return 499;
    case 'INTERNAL_SERVER_ERROR':
      return 500;
    default:
      return 500;
  }
}

// Base router
export const router = t.router;

// Public procedure (no auth required)
export const publicProcedure = t.procedure;

// Authenticated procedure middleware
const authenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user && !ctx.apiKey) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
  return next({
    ctx: {
      ...ctx,
      // Ensure auth is present
      auth: ctx.user || ctx.apiKey!,
    },
  });
});

// Authenticated procedure
export const protectedProcedure = t.procedure.use(authenticated);

// Rate limiting middleware
const rateLimit = t.middleware(({ ctx, next }) => {
  // TODO: Implement actual rate limiting
  // For now, just pass through
  return next();
});

// Rate limited procedure
export const rateLimitedProcedure = protectedProcedure.use(rateLimit);

// Organization access middleware
const orgAccess = t.middleware(({ ctx, input, next }) => {
  const orgId = (input as any)?.orgId;
  const userOrgId = ctx.user?.orgId || ctx.apiKey?.orgId;

  if (orgId && orgId !== userOrgId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Access denied to organization',
    });
  }

  return next();
});

// Organization scoped procedure
export const orgProcedure = protectedProcedure.use(orgAccess);
