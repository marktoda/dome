import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrivyAuthService } from '../../src/services/privyAuthService';
import { AuthError, AuthErrorType } from '../../src/utils/errors';
import * as jose from 'jose';
import type { User, PrivyClaims } from '../../src/types';

const mockAppId = 'mock-app-id';
const mockPrivyDid = 'did:privy:mockuser';
const mockUserId = 'user-uuid-123';

const mockUser: User = {
  id: mockUserId,
  email: 'test@example.com',
  role: 'user' as any,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockUserAuthProvider = {
  id: 'uap-id-1',
  userId: mockUserId,
  provider: 'privy',
  providerUserId: mockPrivyDid,
  email: 'test@example.com',
  linkedAt: new Date(),
};

const mockDbInstance = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  leftJoin: vi.fn().mockReturnThis(),
  eq: vi.fn((field, value) => ({ field, value, operator: 'eq' })),
  and: vi.fn((...args) => ({ args, operator: 'and' })),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  returning: vi.fn().mockImplementation(() => ({ execute: vi.fn().mockResolvedValue([mockUser]) })),
  get: vi.fn(),
};

const mockKvNamespace = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
};

const mockEnv = {
  AUTH_DB: 'mock-d1-database-binding' as any,
  AUTH_TOKENS: mockKvNamespace as any,
  PRIVY_APP_ID: mockAppId,
};
process.env.PRIVY_APP_ID = mockAppId;

vi.mock('jose', async () => {
  const actualJose = await vi.importActual('jose') as typeof jose;
  return {
    ...actualJose,
    createRemoteJWKSet: vi.fn() as any,
    jwtVerify: vi.fn() as any,
    decodeProtectedHeader: vi.fn() as any,
    decodeJwt: vi.fn() as any,
    importJWK: vi.fn() as any,
  };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => mockDbInstance),
}));

vi.mock('@dome/common', () => ({
    getLogger: vi.fn(() => ({
        child: vi.fn(() => ({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
        })),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    })),
}));

vi.mock('../../src/utils/logging', () => ({
    authMetrics: {
        counter: vi.fn(),
        histogram: vi.fn(),
        gauge: vi.fn(),
    }
}));


describe('PrivyAuthService', () => {
  let privyAuthService: PrivyAuthService;
  let mockPublicKey: CryptoKey;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockKvNamespace.get.mockReset();
    mockKvNamespace.put.mockReset();
    mockDbInstance.get.mockReset();
    const mockExecute = vi.fn().mockResolvedValue([mockUser]);
    (mockDbInstance.insert as any).mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn(() => ({ execute: mockExecute }))
    }));
    mockExecute.mockClear();


    const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
    ) as CryptoKeyPair;
    mockPublicKey = keyPair.publicKey;

    (jose.importJWK as any).mockResolvedValue(mockPublicKey);

    privyAuthService = new PrivyAuthService(mockEnv as any);

    mockKvNamespace.get.mockResolvedValue(null);
    const mockFetchedJwks = { keys: [{ kid: 'mock-kid', alg: 'ES256', use: 'sig', kty: 'EC', crv: 'P-256', x: 'x_coord', y: 'y_coord' }] };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockFetchedJwks,
    } as unknown as Response);

    mockDbInstance.get.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validatePrivyToken', () => {
    const mockJwt = 'mock.jwt.token';
    const mockDecodedHeader = { alg: 'ES256', kid: 'mock-kid' } as jose.ProtectedHeaderParameters;
    const mockClaims: PrivyClaims = {
      iss: 'https://api.privy.io',
      sub: mockPrivyDid,
      aud: mockAppId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000) - 60,
      jti: 'mock-jti-123',
      email: 'test@example.com',
    };

    it('should successfully validate a token, create a new user and provider link', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);
      mockKvNamespace.get.mockResolvedValueOnce(null);
      mockKvNamespace.get.mockResolvedValueOnce(null);

      (jose.jwtVerify as any).mockResolvedValue({ payload: mockClaims, protectedHeader: mockDecodedHeader });

      mockDbInstance.get.mockResolvedValue(null);

      const userInsertExecute = vi.fn().mockResolvedValue([mockUser]);
      const providerInsertExecute = vi.fn().mockResolvedValue([mockUserAuthProvider]);
      (mockDbInstance.insert as any)
        .mockImplementationOnce(() => ({ values: vi.fn().mockReturnThis(), returning: vi.fn(() => ({ execute: userInsertExecute })) }))
        .mockImplementationOnce(() => ({ values: vi.fn().mockReturnThis(), returning: vi.fn(() => ({ execute: providerInsertExecute })) }));

      const result = await privyAuthService.validatePrivyToken(mockJwt);

      expect(jose.decodeProtectedHeader).toHaveBeenCalledWith(mockJwt);
      expect(global.fetch).toHaveBeenCalledWith('https://auth.privy.io/.well-known/jwks.json');
      expect(jose.importJWK).toHaveBeenCalled();
      expect(jose.jwtVerify).toHaveBeenCalledWith(mockJwt, mockPublicKey, expect.objectContaining({
        issuer: 'https://api.privy.io',
        audience: mockAppId,
        algorithms: ['ES256'],
      }));
      expect(mockDbInstance.insert).toHaveBeenCalledTimes(2);
      expect(userInsertExecute).toHaveBeenCalled();
      expect(providerInsertExecute).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.user).toEqual(expect.objectContaining({ id: mockUser.id, email: mockUser.email }));
      expect(result.ttl).toBeGreaterThan(0);
    });

    it('should successfully validate a token and return an existing user via userAuthProvider', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);
      mockKvNamespace.get.mockResolvedValue(null);
      (jose.jwtVerify as any).mockResolvedValue({ payload: mockClaims, protectedHeader: mockDecodedHeader });

      mockDbInstance.get
        .mockResolvedValueOnce(mockUserAuthProvider)
        .mockResolvedValueOnce(mockUser);

      const result = await privyAuthService.validatePrivyToken(mockJwt);

      expect(mockDbInstance.get).toHaveBeenCalledTimes(2);
      expect(mockDbInstance.insert).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.user).toEqual(expect.objectContaining({ id: mockUser.id }));
    });

    it('should link to an existing user by email if provider link does not exist', async () => {
        (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
        (jose.decodeJwt as any).mockReturnValue(mockClaims);
        mockKvNamespace.get.mockResolvedValue(null);
        (jose.jwtVerify as any).mockResolvedValue({ payload: mockClaims, protectedHeader: mockDecodedHeader });

        mockDbInstance.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(mockUser);

        const providerInsertExecute = vi.fn().mockResolvedValue([mockUserAuthProvider]);
        (mockDbInstance.insert as any).mockImplementationOnce(() => ({ values: vi.fn().mockReturnThis(), returning: vi.fn(() => ({ execute: providerInsertExecute })) }));

        const result = await privyAuthService.validatePrivyToken(mockJwt);

        expect(mockDbInstance.get).toHaveBeenCalledTimes(2);
        expect(mockDbInstance.insert).toHaveBeenCalledTimes(1);
        expect(providerInsertExecute).toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.user?.id).toBe(mockUser.id);
    });


    it('should return success: false if decodeProtectedHeader throws', async () => {
      (jose.decodeProtectedHeader as any).mockImplementation(() => {
        throw new Error('Invalid header');
      });
      const result = await privyAuthService.validatePrivyToken(mockJwt);
      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
    });

    it('should return success: false if JWKS fetching fails (fetch not ok)', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);
      mockKvNamespace.get.mockResolvedValueOnce(null);
      mockKvNamespace.get.mockResolvedValueOnce(null);
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

      const result = await privyAuthService.validatePrivyToken(mockJwt);
      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
    });

     it('should return success: false if public key import fails (jose.importJWK throws)', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);
      mockKvNamespace.get.mockResolvedValue(null);
      (jose.importJWK as any).mockRejectedValue(new Error('Key import error'));

      const result = await privyAuthService.validatePrivyToken(mockJwt);
      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
    });


    it('should return success: false for JWT signature verification failure', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);
      mockKvNamespace.get.mockResolvedValue(null);
      (jose.jwtVerify as any).mockRejectedValue(new jose.errors.JWSSignatureVerificationFailed('Signature verification failed'));

      const result = await privyAuthService.validatePrivyToken(mockJwt);
      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
    });

    it('should return success: false for expired token (jose.errors.JWTExpired)', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);
      mockKvNamespace.get.mockResolvedValue(null);
      (jose.jwtVerify as any).mockRejectedValue(
        new jose.errors.JWTExpired('Token has expired', mockClaims)
      );
      const result = await privyAuthService.validatePrivyToken(mockJwt);
      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
      expect(result.ttl).toBe(0);
    });

    it('should return success: false for invalid audience (jose.errors.JWTClaimValidationFailed)', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);
      mockKvNamespace.get.mockResolvedValue(null);
      (jose.jwtVerify as any).mockRejectedValue(
        Object.assign(new Error('Invalid audience'), {
          name: 'JWTClaimValidationFailed',
          code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
          claim: 'aud',
          reason: 'invalid',
        })
      );
      const result = await privyAuthService.validatePrivyToken(mockJwt);
      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
    });

     it('should return success: false for token used before nbf (service internal check)', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      const nbfPayload = { ...mockClaims, nbf: Math.floor(Date.now() / 1000) + 3600 };
      (jose.decodeJwt as any).mockReturnValue(nbfPayload);
      mockKvNamespace.get.mockResolvedValue(null);
      (jose.jwtVerify as any).mockResolvedValue({ payload: nbfPayload, protectedHeader: mockDecodedHeader });

      const result = await privyAuthService.validatePrivyToken(mockJwt);
      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
    });

    it('should return success: false if privy DID (sub) is missing in claims (AuthError from mapOrCreateUser)', async () => {
      const invalidClaims = { ...mockClaims, sub: undefined } as unknown as PrivyClaims;
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(invalidClaims);
      mockKvNamespace.get.mockResolvedValue(null);
      (jose.jwtVerify as any).mockResolvedValue({ payload: invalidClaims, protectedHeader: mockDecodedHeader });

      const result = await privyAuthService.validatePrivyToken(mockJwt);
      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
    });

    it('should return success: false if user creation fails (DB error in mapOrCreateUser)', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);
      (jose.jwtVerify as any).mockResolvedValue({ payload: mockClaims, protectedHeader: mockDecodedHeader });
      mockKvNamespace.get.mockResolvedValue(null);

      mockDbInstance.get.mockResolvedValue(null);
      (mockDbInstance.insert() as any).values().returning().execute.mockRejectedValue(new Error('DB user insert error'));

      const result = await privyAuthService.validatePrivyToken(mockJwt);
      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
    });

    it('should return success: false if user auth provider creation fails (DB error in mapOrCreateUser)', async () => {
        (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
        (jose.decodeJwt as any).mockReturnValue(mockClaims);
        (jose.jwtVerify as any).mockResolvedValue({ payload: mockClaims, protectedHeader: mockDecodedHeader });
        mockKvNamespace.get.mockResolvedValue(null);

        mockDbInstance.get.mockResolvedValue(null);

        const userInsertExecute = vi.fn().mockResolvedValue([mockUser]);
        const providerInsertFailExecute = vi.fn().mockRejectedValue(new Error('DB provider insert error'));
        (mockDbInstance.insert as any)
            .mockImplementationOnce(() => ({ values: vi.fn().mockReturnThis(), returning: vi.fn(() => ({ execute: userInsertExecute })) }))
            .mockImplementationOnce(() => ({ values: vi.fn().mockReturnThis(), returning: vi.fn(() => ({ execute: providerInsertFailExecute })) }));

        const result = await privyAuthService.validatePrivyToken(mockJwt);
        expect(result.success).toBe(false);
        expect(result.user).toBeNull();
    });


    it('should use cached JWKS if available in KV', async () => {
      const cachedJwksData = { keys: [{ kid: 'cached-kid', alg: 'ES256', use: 'sig', kty: 'EC', crv: 'P-256', x: 'cx', y: 'cy' }] };
      mockKvNamespace.get.mockResolvedValueOnce(JSON.stringify(cachedJwksData));
      mockKvNamespace.get.mockResolvedValueOnce(null);

      const headerWithCachedKid = { ...mockDecodedHeader, kid: 'cached-kid' };
      (jose.decodeProtectedHeader as any).mockReturnValue(headerWithCachedKid);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);
      (jose.jwtVerify as any).mockResolvedValue({ payload: mockClaims, protectedHeader: headerWithCachedKid });
      (jose.importJWK as any).mockResolvedValue(mockPublicKey);

      mockDbInstance.get.mockResolvedValueOnce(mockUserAuthProvider).mockResolvedValueOnce(mockUser);

      await privyAuthService.validatePrivyToken(mockJwt);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockKvNamespace.get).toHaveBeenCalledWith('privy:jwks', 'json');
      expect(jose.importJWK).toHaveBeenCalledWith(cachedJwksData.keys[0] as unknown as jose.JWK, undefined);
    });

    it('should return success: false if JTI is found in KV (revoked)', async () => {
      (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
      (jose.decodeJwt as any).mockReturnValue(mockClaims);

      mockKvNamespace.get.mockResolvedValueOnce(null);
      mockKvNamespace.get.mockResolvedValueOnce('1');

      const result = await privyAuthService.validatePrivyToken(mockJwt);

      expect(result.success).toBe(false);
      expect(result.user).toBeNull();
      expect(mockKvNamespace.get).toHaveBeenCalledWith(`revoked_jti:${mockClaims.jti}`);
      expect(jose.jwtVerify).not.toHaveBeenCalled();
    });

    it('should return success: false if jti or exp is missing from token for revocation check', async () => {
        const payloadMissingJti = { ...mockClaims, jti: undefined } as unknown as PrivyClaims;
        (jose.decodeProtectedHeader as any).mockReturnValue(mockDecodedHeader);
        (jose.decodeJwt as any).mockReturnValue(payloadMissingJti);

        const result = await privyAuthService.validatePrivyToken(mockJwt);
        expect(result.success).toBe(false);
        expect(result.user).toBeNull();
    });
  });

  describe('revokeJti', () => {
    const jtiToRevoke = 'test-jti-to-revoke';
    const futureExp = Math.floor(Date.now() / 1000) + 3600;

    it('should store the JTI in KV with correct expiration TTL', async () => {
      await privyAuthService.revokeJti(jtiToRevoke, futureExp);
      const now = Math.floor(Date.now() / 1000);
      const expectedTtl = futureExp - now;
      const putArgs = mockKvNamespace.put.mock.calls[0];
      const actualTtl = putArgs[2].expirationTtl;

      expect(mockKvNamespace.put).toHaveBeenCalledWith(
        `revoked_jti:${jtiToRevoke}`,
        '1',
        expect.objectContaining({ expirationTtl: expect.any(Number) })
      );
      expect(actualTtl).toBeGreaterThan(0);
      expect(actualTtl).toBeLessThanOrEqual(expectedTtl);
      expect(actualTtl).toBeGreaterThanOrEqual(expectedTtl - 5); // Reasonably close
    });

    it('should not store JTI in KV if it is already expired', async () => {
      const pastExp = Math.floor(Date.now() / 1000) - 3600;
      await privyAuthService.revokeJti(jtiToRevoke, pastExp);
      expect(mockKvNamespace.put).not.toHaveBeenCalled();
    });
  });
});