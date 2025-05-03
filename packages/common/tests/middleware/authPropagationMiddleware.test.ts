import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  createAuthPropagationMiddleware, 
  getCurrentIdentity,
  addBaggageHeader
} from '../../src/middleware/authPropagationMiddleware';
import { als, Identity } from '../../src/context/context';
import { UnauthorizedError } from '../../src/errors/ServiceError';

// Mock the verifyJwt function
vi.mock('../../src/middleware/authPropagationMiddleware', async () => {
  const actual = await vi.importActual('../../src/middleware/authPropagationMiddleware');
  return {
    ...(actual as object),
    // Mock the internal verifyJwt function
    verifyJwt: vi.fn().mockImplementation(async (token, secret) => {
      if (!secret) throw new Error('JWT secret not found');
      if (token === 'invalid-token') throw new Error('Invalid token');
      return { sub: 'user-123', org: 'org-abc' };
    })
  };
});

describe('Auth Propagation Middleware', () => {
  // Mock Hono context
  const createMockContext = (headers: Record<string, string> = {}, env = {}) => {
    const ctx = {
      req: {
        header: (name: string) => headers[name.toLowerCase()] || null,
      },
      env: {
        ENVIRONMENT: 'test',
        JWT_SECRET: 'test-secret',
        ...env
      },
      set: vi.fn(),
      get: vi.fn(),
    };
    return ctx;
  };

  // Mock next function
  const mockNext = vi.fn().mockResolvedValue(undefined);

  // Reset mocks between tests
  beforeEach(() => {
    vi.resetAllMocks();
    // Clear any existing ALS context
    als.run(undefined as any, () => {});
  });

  // Store original fetch
  const originalFetch = globalThis.fetch;
  
  afterEach(() => {
    // Restore original fetch after each test
    globalThis.fetch = originalFetch;
  });


  describe('Token Verification', () => {
    it('should throw error when authorization header is missing', async () => {
      // Create middleware
      const middleware = createAuthPropagationMiddleware();
      
      // Create mock context without auth header
      const ctx = createMockContext();
      
      // Execute middleware and expect error
      await expect(middleware(ctx as any, mockNext)).rejects.toThrow(UnauthorizedError);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should throw error when authorization format is invalid', async () => {
      // Create middleware
      const middleware = createAuthPropagationMiddleware();
      
      // Create mock context with invalid auth header
      const ctx = createMockContext({
        authorization: 'InvalidFormat token123'
      });
      
      // Execute middleware and expect error
      await expect(middleware(ctx as any, mockNext)).rejects.toThrow(UnauthorizedError);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should throw error when token verification fails', async () => {
      // Create middleware
      const middleware = createAuthPropagationMiddleware();
      
      // Create mock context with invalid token
      const ctx = createMockContext({
        authorization: 'Bearer invalid-token'
      });
      
      // Execute middleware and expect error
      await expect(middleware(ctx as any, mockNext)).rejects.toThrow(UnauthorizedError);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should extract identity from verified token', async () => {
      // Create middleware
      const middleware = createAuthPropagationMiddleware();
      
      // Create mock context with valid token
      const ctx = createMockContext({
        authorization: 'Bearer valid-token'
      });
      
      // Create a custom next function to capture ALS context
      let identityInAls: Identity | undefined;
      const customNext = async () => {
        identityInAls = als.getStore();
      };
      
      // Execute middleware
      await middleware(ctx as any, customNext);
      
      // Verify identity was set in context
      expect(ctx.set).toHaveBeenCalledWith('identity', {
        uid: 'user-123',
        org: 'org-abc'
      });
      
      // Verify identity was set in ALS
      expect(identityInAls).toEqual({
        uid: 'user-123',
        org: 'org-abc'
      });
    });
  });

  describe('Baggage Header Setup', () => {
    it('should set baggage in Hono context', async () => {
      // Create middleware
      const middleware = createAuthPropagationMiddleware();
      
      // Create mock context with valid token
      const ctx = createMockContext({
        authorization: 'Bearer valid-token'
      });
      
      // Execute middleware
      await middleware(ctx as any, mockNext);
      
      // Verify baggage was set in context
      expect(ctx.set).toHaveBeenCalledWith('baggage', expect.stringContaining('uid=user-123'));
    });

    it('should patch fetch to include baggage header', async () => {
      // Create middleware
      const middleware = createAuthPropagationMiddleware();
      
      // Create mock context with valid token
      const ctx = createMockContext({
        authorization: 'Bearer valid-token'
      });
      
      // Mock fetch
      const fetchSpy = vi.fn().mockResolvedValue(new Response('OK'));
      globalThis.fetch = fetchSpy;
      
      // Create a custom next function that makes a fetch request
      const customNext = async () => {
        await globalThis.fetch('https://example.com');
      };
      
      // Execute middleware
      await middleware(ctx as any, customNext);
      
      // Verify fetch was called with baggage header
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          headers: expect.any(Headers)
        })
      );
      
      // Get the headers from the call
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers.get('baggage')).toContain('uid=user-123');
    });

    it('should restore original fetch after middleware completes', async () => {
      // Create middleware
      const middleware = createAuthPropagationMiddleware();
      
      // Create mock context with valid token
      const ctx = createMockContext({
        authorization: 'Bearer valid-token'
      });
      
      // Store original fetch
      const originalFetch = globalThis.fetch;
      
      // Execute middleware
      await middleware(ctx as any, mockNext);
      
      // Verify fetch was restored
      expect(globalThis.fetch).toBe(originalFetch);
    });
  });

  describe('getCurrentIdentity Helper', () => {
    it('should get identity from Hono context', () => {
      // Create mock context with identity
      const identity: Identity = { uid: 'user-123', org: 'org-abc' };
      const ctx = createMockContext();
      ctx.get = vi.fn().mockReturnValue(identity);
      
      // Get identity
      const result = getCurrentIdentity(ctx as any);
      
      // Verify identity was returned
      expect(result).toEqual(identity);
    });

    it('should fall back to ALS when identity not in Hono context', async () => {
      // Create mock context without identity
      const ctx = createMockContext();
      ctx.get = vi.fn().mockReturnValue(undefined);
      
      // Set identity in ALS
      const identity: Identity = { uid: 'user-123', org: 'org-abc' };
      
      await als.run(identity, async () => {
        // Get identity
        const result = getCurrentIdentity(ctx as any);
        
        // Verify identity was returned from ALS
        expect(result).toEqual(identity);
      });
    });

    it('should throw error when identity not found anywhere', () => {
      // Create mock context without identity
      const ctx = createMockContext();
      ctx.get = vi.fn().mockReturnValue(undefined);
      
      // Get identity and expect error
      expect(() => getCurrentIdentity(ctx as any)).toThrow(UnauthorizedError);
    });
  });

  describe('addBaggageHeader Helper', () => {
    it('should add baggage from Hono context to headers', () => {
      // Create mock context with baggage
      const baggage = 'uid=user-123,org=org-abc';
      const ctx = createMockContext();
      ctx.get = vi.fn().mockReturnValue(baggage);
      
      // Create headers
      const headers = new Headers();
      
      // Add baggage header
      addBaggageHeader(headers, ctx as any);
      
      // Verify header was added
      expect(headers.get('baggage')).toBe(baggage);
    });

    it('should fall back to ALS when baggage not in Hono context', async () => {
      // Create mock context without baggage
      const ctx = createMockContext();
      ctx.get = vi.fn().mockReturnValue(undefined);
      
      // Set identity in ALS
      const identity: Identity = { uid: 'user-123', org: 'org-abc' };
      
      await als.run(identity, async () => {
        // Create headers
        const headers = new Headers();
        
        // Add baggage header
        addBaggageHeader(headers, ctx as any);
        
        // Verify header was added with encoded identity
        expect(headers.get('baggage')).toBe('uid=user-123,org=org-abc');
      });
    });

    it('should not add baggage header when no identity available', () => {
      // Create mock context without baggage
      const ctx = createMockContext();
      ctx.get = vi.fn().mockReturnValue(undefined);
      
      // Create headers
      const headers = new Headers();
      
      // Add baggage header
      addBaggageHeader(headers, ctx as any);
      
      // Verify no header was added
      expect(headers.has('baggage')).toBe(false);
    });
  });
});