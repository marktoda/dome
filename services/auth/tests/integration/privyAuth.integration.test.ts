import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AuthWorker from '../../src/index';
import { PrivyAuthService } from '../../src/services/privyAuthService';
import type { User, ValidateTokenResponse, PrivyClaims } from '../../src/types';
import { AuthError, AuthErrorType } from '../../src/utils/errors';

// Define a minimal Env interface for testing purposes
interface TestEnv {
  AUTH_DB: any; // Mock D1 binding
  AUTH_TOKENS: any; // Mock KV Namespace
  PRIVY_APP_ID: string;
  ENVIRONMENT: "development";
  VERSION: "0.1.0"; // Corrected to specific literal type
  // Add other bindings if your worker's Env expects them
}

// Define a type for the logger mock
interface MockLogger {
    child: any;
    info: any;
    error: any;
    warn: any;
    debug: any;
}

vi.mock('../../src/services/privyAuthService');

const mockDbInstance = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  eq: vi.fn(),
  and: vi.fn(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  returning: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
  get: vi.fn(),
};
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => mockDbInstance),
}));

const mockLoggerInstance: MockLogger = {
    child: vi.fn(() => mockLoggerInstance),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
};
vi.mock('@dome/common', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getLogger: vi.fn(() => mockLoggerInstance),
        withContext: vi.fn((meta, fn) => fn(mockLoggerInstance)),
    };
});


describe('Privy Auth Integration (/validate endpoint)', () => {
  let authWorker: AuthWorker;
  let mockEnv: TestEnv;
  const mockPrivyDid = 'did:privy:test-user';
  const mockUserId = 'user-id-from-privy';
  const mockUserEmail = 'privy-user@example.com';
  let mockExecutionContext: ExecutionContext;


  const mockUser: User = {
    id: mockUserId,
    email: mockUserEmail,
    role: 'user' as any,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockDbInstance.get.mockReset();
    (mockDbInstance.insert().values().returning() as any).execute.mockReset();

    mockEnv = {
      AUTH_DB: 'mock-auth-db-binding',
      AUTH_TOKENS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
      PRIVY_APP_ID: 'test-privy-app-id',
      ENVIRONMENT: 'development',
      VERSION: '0.1.0', // Corrected
    };
    process.env.PRIVY_APP_ID = mockEnv.PRIVY_APP_ID;

    mockExecutionContext = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    authWorker = new AuthWorker(mockExecutionContext, mockEnv);


    (PrivyAuthService as any).mockImplementation((envParam: TestEnv) => {
      const mockPrivyServiceInstance = {
        validatePrivyToken: vi.fn(),
      } as unknown as PrivyAuthService;
      (mockPrivyServiceInstance as any).env = envParam;
      return mockPrivyServiceInstance;
    });
  });

  const getMockedPrivyService = (worker: AuthWorker) => {
    return (worker as any).privyAuthService as { validatePrivyToken: any };
  }


  it('should return 401 if Authorization header is missing', async () => {
    const request = new Request('http://localhost/validate', { method: 'POST' });
    const response = await authWorker.fetch(request);
    expect(response.status).toBe(401);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Missing or malformed Authorization header');
  });

  it('should return 401 if Authorization header is not Bearer', async () => {
    const request = new Request('http://localhost/validate', {
      method: 'POST',
      headers: { Authorization: 'Basic somecreds' },
    });
    const response = await authWorker.fetch(request);
    expect(response.status).toBe(401);
  });

  it('should successfully validate a valid Privy JWT and return user (first time, creates user)', async () => {
    const mockToken = 'valid-privy-jwt-new-user';
    const validatePrivyTokenMock = getMockedPrivyService(authWorker).validatePrivyToken;
    validatePrivyTokenMock.mockResolvedValue({
      success: true,
      user: mockUser,
      ttl: 300,
    });

    const request = new Request('http://localhost/validate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mockToken}` },
    });
    const response = await authWorker.fetch(request);

    expect(response.status).toBe(200);
    const body = await response.json() as ValidateTokenResponse;
    expect(body.success).toBe(true);
    expect(body.user).toEqual(expect.objectContaining({ id: mockUser.id, email: mockUser.email }));
    expect(validatePrivyTokenMock).toHaveBeenCalledWith(mockToken);
  });

  it('should successfully validate a valid Privy JWT and return existing user', async () => {
    const mockToken = 'valid-privy-jwt-existing-user';
    const validatePrivyTokenMock = getMockedPrivyService(authWorker).validatePrivyToken;
    validatePrivyTokenMock.mockResolvedValue({
      success: true,
      user: mockUser,
      ttl: 300,
    });

    const request = new Request('http://localhost/validate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mockToken}` },
    });
    const response = await authWorker.fetch(request);

    expect(response.status).toBe(200);
    const body = await response.json() as ValidateTokenResponse;
    expect(body.success).toBe(true);
    expect(body.user).toEqual(expect.objectContaining({ id: mockUser.id }));
    expect(validatePrivyTokenMock).toHaveBeenCalledWith(mockToken);
  });

  it('should return 401 for an invalid Privy JWT', async () => {
    const mockToken = 'invalid-privy-jwt';
    const validatePrivyTokenMock = getMockedPrivyService(authWorker).validatePrivyToken;
    validatePrivyTokenMock.mockResolvedValue({
      success: false,
      user: null,
      ttl: 0,
    });

    const request = new Request('http://localhost/validate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mockToken}` },
    });
    const response = await authWorker.fetch(request);

    expect(response.status).toBe(401);
    const body = await response.json() as ValidateTokenResponse;
    expect(body.success).toBe(false);
    expect(body.user).toBeNull();
    expect(validatePrivyTokenMock).toHaveBeenCalledWith(mockToken);
  });

  it('should handle errors from PrivyAuthService gracefully', async () => {
    const mockToken = 'error-case-jwt';
    const validatePrivyTokenMock = getMockedPrivyService(authWorker).validatePrivyToken;
    const authError = new AuthError('Service connection failed', AuthErrorType.INTERNAL_ERROR, 500);
    validatePrivyTokenMock.mockRejectedValue(authError);

    const request = new Request('http://localhost/validate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mockToken}` },
    });
    const response = await authWorker.fetch(request);

    expect(response.status).toBe(500);
    const body = await response.json() as { error: { type: string, message: string }};
    expect(body.error).toEqual(authError.toJSON().error);
    expect(validatePrivyTokenMock).toHaveBeenCalledWith(mockToken);
  });

  it('should return 404 for non-existent routes', async () => {
    const request = new Request('http://localhost/nonexistent', { method: 'GET' });
    const response = await authWorker.fetch(request);
    expect(response.status).toBe(404);
  });

  it('should return 200 for /health route', async () => {
    const request = new Request('http://localhost/health', { method: 'GET' });
    const response = await authWorker.fetch(request);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('OK');
  });
});