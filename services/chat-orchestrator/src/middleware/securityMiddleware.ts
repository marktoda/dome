import { Context, MiddlewareHandler, Next } from 'hono';
import { getLogger } from '@dome/logging';
import { 
  createEnhancedAuthMiddleware, 
  UserRole, 
  requireRole 
} from '@dome/common/src/middleware/enhancedAuthMiddleware';
import { createRateLimitMiddleware } from '@dome/common/src/middleware/rateLimitMiddleware';
import { UnauthorizedError, ForbiddenError } from '@dome/common/src/errors/ServiceError';
// @ts-ignore - Using local mocks instead of @tsndr/cloudflare-worker-jwt
import { verify, decode } from '../utils/jwtMock';

/**
 * JWT verification options
 */
interface JwtOptions {
  /**
   * Secret key for JWT verification
   */
  secretKey: string;
  
  /**
   * Issuer to validate
   */
  issuer?: string;
  
  /**
   * Audience to validate
   */
  audience?: string;
  
  /**
   * Header name for the JWT token
   * @default 'authorization'
   */
  headerName?: string;
}

/**
 * API key verification options
 */
interface ApiKeyOptions {
  /**
   * Header name for the API key
   * @default 'x-api-key'
   */
  headerName?: string;
  
  /**
   * Environment variable name for the API key
   * @default 'API_KEY'
   */
  envVarName?: string;
}

/**
 * Service-to-service authentication options
 */
interface ServiceAuthOptions {
  /**
   * Header name for the service token
   * @default 'x-service-token'
   */
  headerName?: string;
  
  /**
   * Environment variable prefix for service tokens
   * Each service should have its own token defined as {prefix}_{SERVICE_NAME}
   * @default 'SERVICE_TOKEN'
   */
  envVarPrefix?: string;
  
  /**
   * List of allowed service names
   */
  allowedServices: string[];
}

/**
 * Rate limiting options
 */
interface RateLimitOptions {
  /**
   * Time window in milliseconds
   * @default 60000 (1 minute)
   */
  windowMs?: number;
  
  /**
   * Maximum number of requests per window
   * @default 100
   */
  maxRequests?: number;
  
  /**
   * Whether to use user ID for rate limiting instead of IP
   * @default true
   */
  userBased?: boolean;
}

/**
 * Creates a JWT authentication middleware
 * @param options JWT options
 * @returns Middleware handler
 */
export function createJwtAuthMiddleware(options: JwtOptions): MiddlewareHandler {
  const {
    secretKey,
    issuer,
    audience,
    headerName = 'authorization',
  } = options;
  
  const logger = getLogger().child({ middleware: 'jwtAuth' });
  
  return async (c: Context, next: Next) => {
    // Get authorization header
    const authHeader = c.req.header(headerName);
    
    // Check if authorization header is provided
    if (!authHeader) {
      logger.warn('Missing authorization header');
      throw new UnauthorizedError('Authorization header is required');
    }
    
    // Check if it's a Bearer token
    if (!authHeader.startsWith('Bearer ')) {
      logger.warn('Invalid authorization format');
      throw new UnauthorizedError('Invalid authorization format. Use Bearer token');
    }
    
    // Extract the token
    const token = authHeader.substring(7);
    
    try {
      // Verify the token
      const isValid = await verify(token, secretKey, {
        issuer,
        audience,
      });
      
      if (!isValid) {
        logger.warn('Invalid JWT token');
        throw new UnauthorizedError('Invalid token');
      }
      
      // Decode the token payload
      const { payload } = decode(token);
      
      // Set user info in the context
      c.set('userInfo', {
        id: payload.sub as string,
        email: payload.email as string,
        role: (payload.role as UserRole) || UserRole.USER,
        permissions: (payload.permissions as string[]) || [],
      });
      
      logger.debug({ userId: payload.sub }, 'JWT authentication successful');
      
      // Continue to next middleware
      await next();
    } catch (error) {
      logger.error({ err: error }, 'JWT authentication failed');
      throw new UnauthorizedError('Invalid or expired token');
    }
  };
}

/**
 * Creates an API key authentication middleware
 * @param options API key options
 * @returns Middleware handler
 */
export function createApiKeyAuthMiddleware(options: ApiKeyOptions): MiddlewareHandler {
  const {
    headerName = 'x-api-key',
    envVarName = 'API_KEY',
  } = options;
  
  const logger = getLogger().child({ middleware: 'apiKeyAuth' });
  
  return async (c: Context, next: Next) => {
    // Get API key from header
    const apiKey = c.req.header(headerName);
    
    // Check if API key is provided
    if (!apiKey) {
      logger.warn('Missing API key');
      throw new UnauthorizedError('API key is required');
    }
    
    // Get expected API key from environment
    const expectedApiKey = c.env?.[envVarName];
    
    // Check if API key is valid
    if (!expectedApiKey || apiKey !== expectedApiKey) {
      logger.warn('Invalid API key');
      throw new UnauthorizedError('Invalid API key');
    }
    
    logger.debug('API key authentication successful');
    
    // Set a default user info for API key authentication
    c.set('userInfo', {
      id: 'api-client',
      role: UserRole.USER,
      permissions: ['api:access'],
    });
    
    // Continue to next middleware
    await next();
  };
}

/**
 * Creates a service-to-service authentication middleware
 * @param options Service authentication options
 * @returns Middleware handler
 */
export function createServiceAuthMiddleware(options: ServiceAuthOptions): MiddlewareHandler {
  const {
    headerName = 'x-service-token',
    envVarPrefix = 'SERVICE_TOKEN',
    allowedServices,
  } = options;
  
  const logger = getLogger().child({ middleware: 'serviceAuth' });
  
  return async (c: Context, next: Next) => {
    // Get service token from header
    const serviceToken = c.req.header(headerName);
    
    // Check if service token is provided
    if (!serviceToken) {
      logger.warn('Missing service token');
      throw new UnauthorizedError('Service token is required');
    }
    
    // Get service name from header
    const serviceName = c.req.header('x-service-name');
    
    if (!serviceName) {
      logger.warn('Missing service name');
      throw new UnauthorizedError('Service name is required');
    }
    
    // Check if service is allowed
    if (!allowedServices.includes(serviceName)) {
      logger.warn({ serviceName }, 'Service not allowed');
      throw new ForbiddenError(`Service ${serviceName} is not allowed`);
    }
    
    // Get expected service token from environment
    const envVarName = `${envVarPrefix}_${serviceName.toUpperCase().replace(/-/g, '_')}`;
    const expectedServiceToken = c.env?.[envVarName];
    
    // Check if service token is valid
    if (!expectedServiceToken || serviceToken !== expectedServiceToken) {
      logger.warn({ serviceName }, 'Invalid service token');
      throw new UnauthorizedError('Invalid service token');
    }
    
    logger.debug({ serviceName }, 'Service authentication successful');
    
    // Set service info in the context
    c.set('serviceInfo', {
      name: serviceName,
      permissions: ['service:access'],
    });
    
    // Set a default user info for service authentication
    c.set('userInfo', {
      id: `service-${serviceName}`,
      role: UserRole.USER,
      permissions: ['service:access'],
    });
    
    // Continue to next middleware
    await next();
  };
}

/**
 * Creates a user-based rate limiting middleware
 * @param options Rate limit options
 * @returns Middleware handler
 */
export function createUserRateLimitMiddleware(options: RateLimitOptions = {}): MiddlewareHandler {
  const {
    windowMs = 60000,
    maxRequests = 100,
    userBased = true,
  } = options;
  
  const logger = getLogger().child({ middleware: 'rateLimit' });
  
  // Create key generator function
  const keyGenerator = (c: Context): string => {
    if (userBased) {
      // Try to get user ID from context
      try {
        const userInfo = c.get('userInfo');
        if (userInfo && userInfo.id) {
          return `user:${userInfo.id}`;
        }
      } catch (error) {
        // Ignore error and fall back to IP
      }
    }
    
    // Fall back to IP address
    return c.req.header('x-forwarded-for') || 
           c.req.header('cf-connecting-ip') || 
           'unknown';
  };
  
  // Create rate limit middleware
  const rateLimitMiddleware = createRateLimitMiddleware(
    windowMs,
    maxRequests,
    keyGenerator
  );
  
  return async (c: Context, next: Next) => {
    try {
      await rateLimitMiddleware(c, next);
    } catch (error) {
      logger.warn({ 
        userId: c.get('userInfo')?.id,
        ip: c.req.header('cf-connecting-ip')
      }, 'Rate limit exceeded');
      throw error;
    }
  };
}

/**
 * Creates a comprehensive security middleware that combines authentication,
 * authorization, and rate limiting
 * @param options Security options
 * @returns Middleware handler
 */
export function createSecurityMiddleware(options: {
  auth: 'jwt' | 'apiKey' | 'service' | 'none';
  jwtOptions?: JwtOptions;
  apiKeyOptions?: ApiKeyOptions;
  serviceOptions?: ServiceAuthOptions;
  rateLimit?: RateLimitOptions;
  requiredRole?: UserRole;
  requiredPermissions?: string[];
}): MiddlewareHandler {
  const {
    auth,
    jwtOptions,
    apiKeyOptions,
    serviceOptions,
    rateLimit,
    requiredRole,
    requiredPermissions,
  } = options;
  
  const middlewares: MiddlewareHandler[] = [];
  
  // Add authentication middleware
  switch (auth) {
    case 'jwt':
      if (!jwtOptions) {
        throw new Error('JWT options are required for JWT authentication');
      }
      middlewares.push(createJwtAuthMiddleware(jwtOptions));
      break;
    case 'apiKey':
      if (!apiKeyOptions) {
        throw new Error('API key options are required for API key authentication');
      }
      middlewares.push(createApiKeyAuthMiddleware(apiKeyOptions));
      break;
    case 'service':
      if (!serviceOptions) {
        throw new Error('Service options are required for service authentication');
      }
      middlewares.push(createServiceAuthMiddleware(serviceOptions));
      break;
    case 'none':
      // No authentication
      break;
    default:
      throw new Error(`Unknown authentication type: ${auth}`);
  }
  
  // Add authorization middleware if required
  if (requiredRole) {
    middlewares.push(requireRole(requiredRole));
  }
  
  if (requiredPermissions && requiredPermissions.length > 0) {
    middlewares.push(createEnhancedAuthMiddleware({
      requiredPermissions,
    }));
  }
  
  // Add rate limiting middleware if enabled
  if (rateLimit) {
    middlewares.push(createUserRateLimitMiddleware(rateLimit));
  }
  
  // Combine all middlewares
  return async (c: Context, next: Next) => {
    for (const middleware of middlewares) {
      await middleware(c, next);
    }
  };
}

/**
 * Creates a middleware for mutual TLS verification
 * This is a placeholder that would be implemented with actual mTLS verification
 * @returns Middleware handler
 */
export function createMutualTlsMiddleware(): MiddlewareHandler {
  const logger = getLogger().child({ middleware: 'mutualTls' });
  
  return async (c: Context, next: Next) => {
    // In a real implementation, we would verify the client certificate
    // For Cloudflare Workers, this would use the cf object in the request
    const clientCertPresent = c.req.raw.cf?.clientCertPresent;
    const clientCertVerified = c.req.raw.cf?.clientCertVerified;
    const clientCertIssuer = c.req.raw.cf?.clientCertIssuer;
    
    if (!clientCertPresent) {
      logger.warn('Client certificate not present');
      throw new UnauthorizedError('Client certificate is required');
    }
    
    if (!clientCertVerified) {
      logger.warn('Client certificate not verified');
      throw new UnauthorizedError('Client certificate verification failed');
    }
    
    logger.debug({ 
      clientCertIssuer 
    }, 'Mutual TLS verification successful');
    
    await next();
  };
}