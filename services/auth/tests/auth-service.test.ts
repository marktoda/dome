import { describe, it, expect } from 'vitest';
import { AuthService, AuthServiceDependencies } from '../src/services/auth-service';
import { JwtTokenManager } from '../src/services/token/token-manager';
import { BaseAuthProvider } from '../src/services/providers/base-auth-provider';
import { SupportedAuthProvider, User } from '../src/types';

const tokenSettings = {
  accessTokenSecret: 'access-secret',
  accessTokenExpiresIn: '1h',
  refreshTokenSecret: 'refresh-secret',
  refreshTokenExpiresIn: '7d',
  issuer: 'test',
  audience: 'test',
};

class MockProvider extends BaseAuthProvider {
  readonly providerName = SupportedAuthProvider.LOCAL;
  private user: User;
  constructor(tm: any, user: User) { super(tm); this.user = user; }
  async authenticate(): Promise<any> {
    const { accessToken, refreshToken } = await this.generateTokens(this.user);
    return { success: true, user: this.user, accessToken, refreshToken };
  }
  async register(): Promise<any> { return this.authenticate(); }
  async getUserFromToken(token: string): Promise<User | null> {
    const payload = await this.tokenManager.verifyAccessToken(token);
    if (payload.userId === this.user.id) return this.user; return null;
  }
}

function createAuthService(user: User) {
  const tokenManager = new JwtTokenManager(tokenSettings);
  const provider = new MockProvider(tokenManager, user);
  const deps: AuthServiceDependencies = {
    userManager: {
      findUserById: async (id: string) => (id === user.id ? user : null),
    } as any,
    providerServices: new Map([[SupportedAuthProvider.LOCAL, provider]]),
    tokenManager,
    env: {},
  };
  return { service: new AuthService(deps), provider, tokenManager };
}

describe('AuthService', () => {
  const user: User = {
    id: 'u1',
    email: 'user@example.com',
    name: 'User',
    role: 'user',
    emailVerified: true,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    password: null,
    lastLoginAt: null,
    authProvider: 'local',
    providerAccountId: 'u1',
  };

  it('logs in via provider', async () => {
    const { service, tokenManager } = createAuthService(user);
    const result = await service.login('local', {});
    const payload = await tokenManager.verifyAccessToken(result.tokenInfo.token);
    expect(payload.userId).toBe(user.id);
  });

  it('registers via provider', async () => {
    const { service, tokenManager } = createAuthService(user);
    const result = await service.register('local', {});
    expect(result.user.id).toBe(user.id);
    const payload = await tokenManager.verifyAccessToken(result.tokenInfo.token);
    expect(payload.userId).toBe(user.id);
  });

  it('validates token using provider when providerName supplied', async () => {
    const { service } = createAuthService(user);
    const login = await service.login('local', {});
    const validation = await service.validateToken(login.tokenInfo.token, SupportedAuthProvider.LOCAL);
    expect(validation.userId).toBe(user.id);
    expect(validation.provider).toBe(SupportedAuthProvider.LOCAL);
  });

  it('validates token using TokenManager when providerName omitted', async () => {
    const { service, tokenManager } = createAuthService(user);
    const token = await tokenManager.generateAccessToken({ userId: user.id });
    const validation = await service.validateToken(token);
    expect(validation.userId).toBe(user.id);
    expect(validation.provider).toBe(SupportedAuthProvider.LOCAL);
  });
});
