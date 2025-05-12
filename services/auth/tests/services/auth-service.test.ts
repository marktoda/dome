import { describe, it, expect, vi, beforeEach, Mocked, Mock } from 'vitest';
import { AuthService } from '../../src/services/auth-service';
import { IUserManager } from '../../src/services/user/user-manager';
import { BaseAuthProvider, AuthResult } from '../../src/services/providers/base-auth-provider';
import { TokenManager } from '../../src/services/token/token-manager';
import { User as SchemaUser, SupportedAuthProvider } from '../../src/types';
import { UnauthorizedError, ValidationError, ServiceError } from '@dome/common/errors';

// Mocks
const mockUserManager: Mocked<IUserManager> = {
  createUser: vi.fn(),
  findUserById: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserByProvider: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  linkProviderToUser: vi.fn(),
  unlinkProviderFromUser: vi.fn(),
};

const mockTokenManager: Mocked<TokenManager> = {
  generateAccessToken: vi.fn(),
  generateRefreshToken: vi.fn(),
  verifyAccessToken: vi.fn(),
  verifyRefreshToken: vi.fn(),
  decodeToken: vi.fn(),
  revokeToken: vi.fn(),
};

// Mock Provider Classes
class MockBaseAuthProvider extends BaseAuthProvider {
  public providerName: string;
  public authenticate = vi.fn() as Mock<[credentials: Record<string, any>], Promise<AuthResult>>;
  public register = vi.fn() as Mock<[registrationData: Record<string, any>], Promise<AuthResult>> | undefined;
  public getUserFromToken = vi.fn() as Mock<[accessToken: string], Promise<SchemaUser | null>>;
  public override logout = vi.fn() as Mock<[token: string], Promise<void>>; // Override to make it a mock
  public override refreshAccessToken = vi.fn() as Mock<[refreshToken: string], Promise<AuthResult>>;
  public override findUserById = vi.fn() as Mock<[userId: string], Promise<SchemaUser | null>>; // Override to make it a mock

  constructor(providerName: string, tokenManager: TokenManager) {
    super(tokenManager);
    this.providerName = providerName;
  }
  // generateTokens is protected, so we don't mock it directly unless testing it specifically through a derived class method
}

const mockEnv = {
  AUTH_DB: 'mock-d1-binding',
  // other env vars if needed
};

describe('AuthService (Unified) Unit Tests', () => {
  let authService: AuthService;
  let mockLocalAuthProvider: MockBaseAuthProvider;
  let mockPrivyAuthProvider: MockBaseAuthProvider;
  let mockProviderServices: Map<string, BaseAuthProvider>;

  const mockSchemaUser: SchemaUser = {
    id: 'user-schema-123',
    email: 'test@example.com',
    name: 'Test Schema User',
    role: 'user',
    emailVerified: true,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    password: null,
    lastLoginAt: null,
    authProvider: SupportedAuthProvider.LOCAL,
    providerAccountId: 'local-user-123',
  };

  const mockAuthResult: AuthResult = {
    success: true,
    user: mockSchemaUser,
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockLocalAuthProvider = new MockBaseAuthProvider(SupportedAuthProvider.LOCAL, mockTokenManager);
    mockPrivyAuthProvider = new MockBaseAuthProvider('privy', mockTokenManager);

    mockProviderServices = new Map();
    mockProviderServices.set(SupportedAuthProvider.LOCAL, mockLocalAuthProvider);
    mockProviderServices.set('privy', mockPrivyAuthProvider);

    authService = new AuthService({
      userManager: mockUserManager,
      providerServices: mockProviderServices,
      tokenManager: mockTokenManager,
      env: mockEnv,
    });
  });

  describe('login', () => {
    it('should login a user with a valid provider and credentials', async () => {
      const credentials = { email: 'test@example.com', password: 'password' };
      mockLocalAuthProvider.authenticate.mockResolvedValue(mockAuthResult);

      const result = await authService.login(SupportedAuthProvider.LOCAL, credentials);

      expect(mockLocalAuthProvider.authenticate).toHaveBeenCalledWith(credentials);
      expect(result.user).toEqual(mockSchemaUser);
      expect(result.tokenInfo.token).toBe(mockAuthResult.accessToken);
      expect(result.tokenInfo.refreshToken).toBe(mockAuthResult.refreshToken);
      // We also need to mock decodeToken if we want to check expiresAt and type
      // For now, we'll assume tokenInfo structure is correct if token and refreshToken match
    });

    it('should throw ValidationError for an unsupported provider type', async () => {
      await expect(authService.login('invalid-provider', {})).rejects.toThrow(ValidationError);
      await expect(authService.login('invalid-provider', {})).rejects.toThrow('Unsupported or unconfigured provider: invalid-provider');
    });

    it('should throw UnauthorizedError if provider authentication fails', async () => {
      mockLocalAuthProvider.authenticate.mockRejectedValue(new Error('Provider internal error'));
      await expect(authService.login(SupportedAuthProvider.LOCAL, {})).rejects.toThrow(UnauthorizedError);
      await expect(authService.login(SupportedAuthProvider.LOCAL, {})).rejects.toThrow('Login failed');
    });
  });

  describe('register', () => {
    const registrationData = { email: 'new@example.com', password: 'newpassword' };
    it('should register a user with a valid provider and details', async () => {
      mockLocalAuthProvider.register!.mockResolvedValue(mockAuthResult); // Use non-null assertion if register is defined

      const result = await authService.register(SupportedAuthProvider.LOCAL, registrationData);
      expect(mockLocalAuthProvider.register).toHaveBeenCalledWith(registrationData);
      expect(result.user).toEqual(mockSchemaUser);
      expect(result.tokenInfo.token).toBe(mockAuthResult.accessToken);
      // Similar to login, checking expiresAt and type would require mocking decodeToken
    });

    it('should throw ValidationError if provider does not support registration', async () => {
      const mockNoRegisterProvider = new MockBaseAuthProvider('no-register-provider', mockTokenManager);
      mockNoRegisterProvider.register = undefined; // Explicitly set register to undefined
      mockProviderServices.set('no-register-provider', mockNoRegisterProvider);

      await expect(authService.register('no-register-provider', {})).rejects.toThrow('Registration is not supported by the no-register-provider provider.');
    });

    it('should throw ValidationError if provider registration fails', async () => {
      mockLocalAuthProvider.register!.mockRejectedValue(new Error('Provider registration issue'));
      await expect(authService.register(SupportedAuthProvider.LOCAL, registrationData)).rejects.toThrow(ValidationError);
      await expect(authService.register(SupportedAuthProvider.LOCAL, registrationData)).rejects.toThrow('Registration failed');
    });
  });

  describe('validateToken', () => {
    const tokenToValidate = 'some-auth-token';

    it('should validate a token with a specified provider using getUserFromToken', async () => {
      mockLocalAuthProvider.getUserFromToken.mockResolvedValue(mockSchemaUser);
      const result = await authService.validateToken(tokenToValidate, SupportedAuthProvider.LOCAL);
      expect(mockLocalAuthProvider.getUserFromToken).toHaveBeenCalledWith(tokenToValidate);
      expect(result.userId).toBe(mockSchemaUser.id);
      expect(result.provider).toBe(SupportedAuthProvider.LOCAL);
      expect(result.user).toEqual(mockSchemaUser);
    });

    it('should validate an internal token using TokenManager if no providerName is given', async () => {
      const mockTokenPayload = { userId: mockSchemaUser.id, iss: 'internal' };
      mockTokenManager.verifyAccessToken.mockResolvedValue(mockTokenPayload as any); // Cast as any if payload type differs
      const mockAuthContext = { env: mockEnv, db: mockEnv.AUTH_DB, waitUntil: vi.fn() };
      mockUserManager.findUserById.mockResolvedValue(mockSchemaUser);

      const result = await authService.validateToken(tokenToValidate);

      expect(mockTokenManager.verifyAccessToken).toHaveBeenCalledWith(tokenToValidate);
      expect(mockUserManager.findUserById).toHaveBeenCalledWith(mockSchemaUser.id, expect.objectContaining(mockAuthContext));
      expect(result.userId).toBe(mockSchemaUser.id);
      expect(result.provider).toBe('internal');
      expect(result.user).toEqual(mockSchemaUser);
    });

    it('should throw UnauthorizedError if specified provider fails validation', async () => {
      mockLocalAuthProvider.getUserFromToken.mockResolvedValue(null);
      await expect(authService.validateToken(tokenToValidate, SupportedAuthProvider.LOCAL)).rejects.toThrow(UnauthorizedError);
      await expect(authService.validateToken(tokenToValidate, SupportedAuthProvider.LOCAL)).rejects.toThrow('Token validation failed: Invalid or expired token for the specified provider.');
    });

    it('should throw UnauthorizedError if internal token validation fails (no providerName)', async () => {
      mockTokenManager.verifyAccessToken.mockRejectedValue(new Error('TokenManager fail'));
      await expect(authService.validateToken(tokenToValidate)).rejects.toThrow(UnauthorizedError);
      await expect(authService.validateToken(tokenToValidate)).rejects.toThrow('Token validation failed: Invalid or expired token.');
    });
  });

  describe('logout', () => {
    const tokenToLogout = 'some-token-for-logout';
    it('should call logout on the specified provider', async () => {
      mockLocalAuthProvider.logout.mockResolvedValue(undefined);
      await authService.logout(tokenToLogout, SupportedAuthProvider.LOCAL);
      expect(mockLocalAuthProvider.logout).toHaveBeenCalledWith(tokenToLogout);
    });

    it('should throw ValidationError for an unsupported provider type during logout', async () => {
      await expect(authService.logout(tokenToLogout, 'unknown-provider')).rejects.toThrow(ValidationError);
      await expect(authService.logout(tokenToLogout, 'unknown-provider')).rejects.toThrow('Unsupported or unconfigured provider: unknown-provider');
    });

    it('should throw ServiceError if provider logout fails', async () => {
      mockLocalAuthProvider.logout.mockRejectedValue(new Error('Provider logout failed'));
      await expect(authService.logout(tokenToLogout, SupportedAuthProvider.LOCAL)).rejects.toThrow(ServiceError);
      await expect(authService.logout(tokenToLogout, SupportedAuthProvider.LOCAL)).rejects.toThrow('Logout operation encountered an issue.');
    });
  });
});