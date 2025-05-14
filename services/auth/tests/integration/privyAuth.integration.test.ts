import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AuthWorker from '../../src/index';
import { PrivyAuthProvider } from '../../src/services/providers/privy-auth-provider';
import type { User, ValidateTokenResponse, PrivyClaims } from '../../src/types';
import { AuthError, AuthErrorType } from '../../src/utils/errors';

// Define a minimal Env interface for testing purposes
interface TestEnv {
  AUTH_DB: any; // Mock D1 binding
  AUTH_TOKENS: any; // Mock KV Namespace
  PRIVY_APP_ID: string;
  ENVIRONMENT: 'development';
  VERSION: '0.1.0'; // Corrected to specific literal type
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

vi.mock('../../src/services/providers/privy-auth-provider');

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
vi.mock('@dome/common', async importOriginal => {
  const actual = (await importOriginal()) as any;
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
    password: null, // Or a mock hashed password if relevant for the test
    name: 'Mock Privy User',
    role: 'user', // Ensure this matches the enum 'user' | 'admin'
    emailVerified: true,
    lastLoginAt: new Date(),
    isActive: true,
    authProvider: 'privy', // Since this is for Privy auth tests
    providerAccountId: mockPrivyDid, // Link to Privy's DID
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

    (PrivyAuthProvider as any).mockImplementation(
      (config: any, tokenManager: any, userManager: any, envParam: TestEnv) => {
        const mockPrivyServiceInstance = {
          validatePrivyToken: vi.fn(), // This method might not exist on PrivyAuthProvider directly
          // It might be part of authenticate or getUserFromToken
          // Mock other methods of BaseAuthProvider if needed by the test logic using privyAuthService
          authenticate: vi.fn(),
          getUserFromToken: vi.fn(),
          providerName: 'privy',
        } as unknown as PrivyAuthProvider;
        // (mockPrivyServiceInstance as any).env = envParam; // Env is usually passed to constructor
        return mockPrivyServiceInstance;
      },
    );
  });

  const getMockedPrivyService = (
    worker: AuthWorker,
  ): { validatePrivyToken: any; authenticate: any; getUserFromToken: any } => {
    // The worker instance itself (AuthWorker from index.ts) initializes AuthService,
    // which in turn initializes providers. We need to access the mocked PrivyAuthProvider
    // instance from the authService.providerServices map.
    // This requires authWorker.unifiedAuthService to be accessible, or we mock at a higher level.

    // For simplicity, if the test relies on a specific `privyAuthService` property on the worker,
    // we'd need to ensure that property is set up with the mock.
    // However, the current AuthWorker (index.ts) doesn't seem to expose individual provider services directly.

    // Let's assume the mock setup for PrivyAuthProvider itself is what we need to interact with.
    // The tests seem to call `authWorker.fetch`, which goes through Hono routes.
    // The Hono routes call `this.unifiedAuthService.validateToken` or other methods.
    // `unifiedAuthService` then calls the provider.

    // The current mock `(PrivyAuthProvider as any).mockImplementation` means any new instance
    // of PrivyAuthProvider will be this mock.
    // The test seems to be structured to mock `PrivyAuthService` and then call methods on it.
    // If `AuthWorker` directly instantiates and uses `PrivyAuthService` (now `PrivyAuthProvider`),
    // then the mock should work.

    // The error `(worker as any).privyAuthService` suggests the test expects this property.
    // The `AuthWorker` (from `src/index.ts`) does not seem to have a `privyAuthService` property.
    // It has `this.unifiedAuthService` which contains the providers.

    // Let's adjust the mock retrieval to get it from the unifiedAuthService if possible,
    // or adjust how PrivyAuthProvider is mocked/used in these tests.

    // Given the original test structure, it seems it was expecting `privyAuthService` on the worker.
    // We'll need to adapt the test or the worker.
    // For now, let's assume the mock implementation of PrivyAuthProvider is what's called.
    // The test calls `getMockedPrivyService(authWorker).validatePrivyToken`.
    // This implies `authWorker` should have a way to get this service.

    // If AuthWorker's constructor in `index.ts` creates and stores `privyAuthProvider` instance,
    // then `(worker as any).privyAuthService` would point to it.
    // Looking at `services/auth/src/index.ts`, it creates providers and passes them to `UnifiedAuthService`.
    // It doesn't store `privyAuthService` directly on `AuthWorker` instance.

    // The mock `(PrivyAuthProvider as any).mockImplementation` will ensure that when
    // `new PrivyAuthProvider(...)` is called within `AuthWorker` (or `UnifiedAuthService`),
    // our mocked instance is used.
    // The challenge is how the test gets a reference to this *specific* mocked instance's methods.

    // One way is to have the mock constructor store the instance globally or return it.
    // Or, the test needs to be refactored to mock the methods on `PrivyAuthProvider.prototype`
    // if it's about instances created by the worker.

    // Let's assume the `PrivyAuthProvider` mock is correctly injected.
    // The test calls `getMockedPrivyService(authWorker).validatePrivyToken`.
    // This suggests `authWorker` should have a `privyAuthService` field.
    // This is not the case in the current `AuthWorker` (`src/index.ts`).

    // The most direct way to fix the test's intent is to ensure the mocked methods are called.
    // The `PrivyAuthProvider` is instantiated within the `AuthWorker` constructor logic.
    // The mock `vi.mock('../../src/services/providers/privy-auth-provider');`
    // combined with `(PrivyAuthProvider as any).mockImplementation(...)` should mean that
    // the instance used by `AuthWorker` is our mock.

    // The test then tries to get this instance via `(worker as any).privyAuthService`.
    // This property does not exist on `AuthWorker`.
    // The `PrivyAuthProvider` instance is inside `authWorker.unifiedAuthService.providerServices.get('privy')`.

    const unifiedAuthService = (worker as any).unifiedAuthService;
    if (unifiedAuthService && unifiedAuthService.providerServices) {
      const privyProviderInstance = unifiedAuthService.providerServices.get('privy');
      if (privyProviderInstance) {
        // We need to ensure the methods on this instance are the vi.fn() mocks.
        // The mockImplementation should handle this.
        return privyProviderInstance as any; // Cast to any to access mocked methods
      }
    }
    // Fallback or error if the provider isn't found, though the mock should ensure it is.
    // This part of the test might need significant refactoring if the above doesn't work.
    // For now, let's assume the mock setup makes `PrivyAuthProvider` instances use the mocked methods.
    // The test was written assuming a `privyAuthService` property.
    // The simplest change to keep the test structure is to mock the prototype if direct instance access is hard.

    // Given the `(PrivyAuthProvider as any).mockImplementation` approach,
    // the instance created inside AuthWorker *is* the mock.
    // The issue is how the test gets a reference to it.
    // The test was likely written when PrivyAuthService was a standalone mocked module.

    // Let's try to return the mocked constructor's return value, assuming it's a singleton for the test.
    // This is a bit of a hack due to the test structure.
    const MockedPrivyAuthProvider = PrivyAuthProvider as any; // Get the mocked constructor
    // This assumes the mockImplementation returns an object with `validatePrivyToken`
    // This is fragile.
    // A better way would be to retrieve the instance from `authWorker.unifiedAuthService.providerServices.get('privy')`
    // and ensure that instance's methods are the mocks.

    // The `PrivyAuthProvider` mock is set up with `validatePrivyToken: vi.fn()`.
    // So, any instance created by `new PrivyAuthProvider()` (which is mocked) will have this.
    // The test needs to get *that* instance.

    // The `authWorker` creates `UnifiedAuthService` which creates `PrivyAuthProvider`.
    // So, `authWorker.unifiedAuthService.providerServices.get('privy')` is the instance.
    const service = (authWorker as any).unifiedAuthService?.providerServices?.get('privy');
    if (!service) {
      throw new Error("Mocked PrivyAuthProvider not found in worker's services. Test setup error.");
    }
    return service as any; // It should have the mocked methods.
  };

  it('should return 401 if Authorization header is missing', async () => {
    const request = new Request('http://localhost/validate', { method: 'POST' });
    const response = await authWorker.fetch(request);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
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
    const body = (await response.json()) as ValidateTokenResponse;
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
    const body = (await response.json()) as ValidateTokenResponse;
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
    const body = (await response.json()) as ValidateTokenResponse;
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
    const body = (await response.json()) as { error: { type: string; message: string } };
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
