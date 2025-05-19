import { describe, it, expect } from 'vitest';
import { JwtTokenManager, TokenPayload } from '../src/services/token/token-manager';
import { TokenSettings } from '../src/config/token-config';

const settings: TokenSettings = {
  accessTokenSecret: 'access-secret',
  accessTokenExpiresIn: '1h',
  refreshTokenSecret: 'refresh-secret',
  refreshTokenExpiresIn: '7d',
  issuer: 'test-issuer',
  audience: 'test-audience',
};

describe('JwtTokenManager', () => {
  const manager = new JwtTokenManager(settings);

  it('generates and verifies an access token', async () => {
    const token = await manager.generateAccessToken({ userId: 'user1' });
    const payload = await manager.verifyAccessToken(token);
    expect(payload.userId).toBe('user1');
    expect(payload.iss).toBe(settings.issuer);
    expect(payload.aud).toBe(settings.audience);
  });

  it('generates and verifies a refresh token', async () => {
    const token = await manager.generateRefreshToken({ userId: 'user2' });
    const payload = await manager.verifyRefreshToken(token);
    expect(payload.userId).toBe('user2');
  });

  it('decodes a token without verifying', async () => {
    const token = await manager.generateAccessToken({ userId: 'user3' });
    const decoded = manager.decodeToken(token);
    expect(decoded.userId).toBe('user3');
  });
});
