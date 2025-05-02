import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { userIdMiddleware } from '../../src/middleware/userIdMiddleware';
import { UnauthorizedError } from '@dome/common';

// Mock the getLogger function
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    child: vi.fn().mockReturnValue({
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    }),
  })),
}));

describe('userIdMiddleware', () => {
  // Mock Hono context
  let mockContext: any;
  let nextCalled: boolean;
  const mockNext = async () => {
    nextCalled = true;
  };

  beforeEach(() => {
    nextCalled = false;
    mockContext = {
      req: {
        path: '/api/test',
        header: vi.fn(),
        query: vi.fn(),
      },
      get: vi.fn(),
      set: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should use user ID from auth context when available', async () => {
    // Arrange
    const authUserId = 'auth-user-123';
    const headerUserId = 'header-user-456';
    mockContext.get.mockReturnValue(authUserId);
    mockContext.req.header.mockReturnValue(headerUserId);

    // Act
    await userIdMiddleware(mockContext, mockNext);

    // Assert
    expect(mockContext.set).toHaveBeenCalledWith('userId', authUserId);
    expect(nextCalled).toBe(true);
  });

  it('should use header user ID for auth routes when auth ID is not available', async () => {
    // Arrange
    mockContext.req.path = '/auth/login';
    mockContext.get.mockReturnValue(undefined); // No auth context
    mockContext.req.header.mockReturnValue('header-user-789');

    // Act
    await userIdMiddleware(mockContext, mockNext);

    // Assert
    expect(mockContext.set).toHaveBeenCalledWith('userId', 'header-user-789');
    expect(nextCalled).toBe(true);
  });

  it('should use header user ID for root route when auth ID is not available', async () => {
    // Arrange
    mockContext.req.path = '/';
    mockContext.get.mockReturnValue(undefined); // No auth context
    mockContext.req.header.mockReturnValue('header-user-789');

    // Act
    await userIdMiddleware(mockContext, mockNext);

    // Assert
    expect(mockContext.set).toHaveBeenCalledWith('userId', 'header-user-789');
    expect(nextCalled).toBe(true);
  });

  it('should use header user ID for health check route when auth ID is not available', async () => {
    // Arrange
    mockContext.req.path = '/health';
    mockContext.get.mockReturnValue(undefined); // No auth context
    mockContext.req.header.mockReturnValue('header-user-789');

    // Act
    await userIdMiddleware(mockContext, mockNext);

    // Assert
    expect(mockContext.set).toHaveBeenCalledWith('userId', 'header-user-789');
    expect(nextCalled).toBe(true);
  });

  it('should throw UnauthorizedError for protected routes when auth ID is missing', async () => {
    // Arrange
    mockContext.req.path = '/notes';
    mockContext.get.mockReturnValue(undefined); // No auth context
    mockContext.req.header.mockReturnValue('header-user-789');

    // Act & Assert
    await expect(userIdMiddleware(mockContext, mockNext)).rejects.toThrow(UnauthorizedError);
    expect(nextCalled).toBe(false);
  });

  it('should throw UnauthorizedError when no user ID is available', async () => {
    // Arrange
    mockContext.get.mockReturnValue(undefined); // No auth context
    mockContext.req.header.mockReturnValue(undefined); // No header
    mockContext.req.query.mockReturnValue(undefined); // No query param

    // Act & Assert
    await expect(userIdMiddleware(mockContext, mockNext)).rejects.toThrow(UnauthorizedError);
    expect(nextCalled).toBe(false);
  });

  it('should use fallback to query param for auth routes', async () => {
    // Arrange
    mockContext.req.path = '/auth/login';
    mockContext.get.mockReturnValue(undefined); // No auth context
    mockContext.req.header.mockReturnValue(undefined); // No header
    mockContext.req.query.mockReturnValue('query-user-789'); // Query param

    // Act
    await userIdMiddleware(mockContext, mockNext);

    // Assert
    expect(mockContext.set).toHaveBeenCalledWith('userId', 'query-user-789');
    expect(nextCalled).toBe(true);
  });
});