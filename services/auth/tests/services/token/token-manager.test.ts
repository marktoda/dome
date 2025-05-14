import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as jose from 'jose';
import { JwtTokenManager, TokenPayload } from '../../../src/services/token/token-manager';
import { getTokenSettings, TokenSettings } from '../../../src/config/token-config';

// Mock environment for getTokenSettings
const mockEnv = {
  JWT_ACCESS_TOKEN_SECRET: 'test-super-secret-key-for-access-tokens',
  JWT_REFRESH_TOKEN_SECRET: 'test-super-secret-key-for-refresh-tokens',
  JWT_ISSUER: 'test-issuer',
  JWT_AUDIENCE: 'test-audience',
  JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
  JWT_REFRESH_TOKEN_EXPIRES_IN: '7d',
};

describe('JwtTokenManager Unit Tests', () => {
  let tokenManager: JwtTokenManager;
  let tokenSettings: TokenSettings;

  beforeEach(() => {
    tokenSettings = getTokenSettings(mockEnv);
    tokenManager = new JwtTokenManager(tokenSettings);
  });

  const userPayload: TokenPayload = {
    userId: 'user-123',
    // Add any other custom claims you expect in your payload
    customClaim: 'customValue',
  };

  describe('Access Token', () => {
    it('should generate a valid access token', async () => {
      const token = await tokenManager.generateAccessToken(userPayload);
      expect(token).toBeTypeOf('string');

      const decoded = jose.decodeJwt(token);
      expect(decoded.userId).toBe(userPayload.userId);
      expect(decoded.customClaim).toBe(userPayload.customClaim);
      expect(decoded.iss).toBe(tokenSettings.issuer);
      expect(decoded.aud).toBe(tokenSettings.audience);
    });

    it('should verify a valid access token', async () => {
      const token = await tokenManager.generateAccessToken(userPayload);
      const verifiedPayload = await tokenManager.verifyAccessToken(token);

      expect(verifiedPayload.userId).toBe(userPayload.userId);
      expect(verifiedPayload.customClaim).toBe(userPayload.customClaim);
      expect(verifiedPayload.iss).toBe(tokenSettings.issuer);
      expect(verifiedPayload.aud).toBe(tokenSettings.audience);
    });

    it('should throw an error for an expired access token', async () => {
      // Generate token with very short expiry for testing
      const shortExpiryTokenManager = new JwtTokenManager({
        ...tokenSettings,
        accessTokenExpiresIn: '1ms', // 1 millisecond
      });
      const token = await shortExpiryTokenManager.generateAccessToken(userPayload);

      // Wait for token to expire
      await new Promise(resolve => setTimeout(resolve, 50)); // Wait 50ms

      await expect(shortExpiryTokenManager.verifyAccessToken(token)).rejects.toThrow(
        /Access token expired/,
      );
    });

    it('should throw an error for an invalid access token signature', async () => {
      const token = await tokenManager.generateAccessToken(userPayload);
      // Create another manager with a different secret to simulate signature mismatch
      const differentSecretManager = new JwtTokenManager({
        ...tokenSettings,
        accessTokenSecret: 'another-different-secret-key',
      });
      await expect(differentSecretManager.verifyAccessToken(token)).rejects.toThrow(
        /Invalid access token/,
      ); // jose throws 'signature verification failed'
    });
  });

  describe('Refresh Token', () => {
    const refreshPayload: Pick<TokenPayload, 'userId'> = { userId: 'user-123-refresh' };

    it('should generate a valid refresh token', async () => {
      const token = await tokenManager.generateRefreshToken(refreshPayload);
      expect(token).toBeTypeOf('string');

      const decoded = jose.decodeJwt(token);
      expect(decoded.userId).toBe(refreshPayload.userId);
      expect(decoded.iss).toBe(tokenSettings.issuer);
      // Audience might be different for refresh tokens if configured that way
      expect(decoded.aud).toBe(tokenSettings.audience);
    });

    it('should verify a valid refresh token', async () => {
      const token = await tokenManager.generateRefreshToken(refreshPayload);
      const verifiedPayload = await tokenManager.verifyRefreshToken(token);

      expect(verifiedPayload.userId).toBe(refreshPayload.userId);
      // Refresh token payload is minimal, so iss/aud might not be in verified payload directly
      // but are checked during jose.jwtVerify
    });

    it('should throw an error for an expired refresh token', async () => {
      const shortExpiryTokenManager = new JwtTokenManager({
        ...tokenSettings,
        refreshTokenExpiresIn: '1ms',
      });
      const token = await shortExpiryTokenManager.generateRefreshToken(refreshPayload);
      await new Promise(resolve => setTimeout(resolve, 50));
      await expect(shortExpiryTokenManager.verifyRefreshToken(token)).rejects.toThrow(
        /Refresh token expired/,
      );
    });
  });

  describe('decodeToken', () => {
    it('should decode a token without verification', async () => {
      const token = await tokenManager.generateAccessToken(userPayload);
      const decodedPayload = tokenManager.decodeToken(token);
      expect(decodedPayload.userId).toBe(userPayload.userId);
      expect(decodedPayload.customClaim).toBe(userPayload.customClaim);
    });

    it('should throw if decoding fails (e.g., not a JWT)', () => {
      expect(() => tokenManager.decodeToken('not-a-jwt-string')).toThrow(/Failed to decode token/); // jose may throw "Invalid JWT"
    });
  });

  describe('revokeToken', () => {
    it('should conceptually revoke a token (placeholder implementation)', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn');
      await tokenManager.revokeToken('some-token-to-revoke');
      // This test mainly checks that the method runs without error
      // and logs the warning as per the placeholder implementation.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Revocation requested for token'),
      );
      consoleWarnSpy.mockRestore();
    });
  });
});
