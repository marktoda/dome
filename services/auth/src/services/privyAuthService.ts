import { DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import * as jose from 'jose';
import { getLogger } from '@dome/common';
import { users, userAuthProviders } from '../db/schema';
import { User, UserRole, PrivyClaims, Jwks, Jwk, ValidateTokenResponse } from '../types';
import { AuthError, AuthErrorType } from '../utils/errors';
import { authMetrics } from '../utils/logging'; // Assuming authMetrics can be used/extended

const PRIVY_ISSUER = 'https://api.privy.io';
const PRIVY_JWKS_URL = 'https://auth.privy.io/.well-known/jwks.json'; // Standard JWKS path
// TODO: Replace 'YOUR_EXPECTED_AUDIENCE' with the actual Privy App ID from environment variables or configuration.
const EXPECTED_AUDIENCE = process.env.PRIVY_APP_ID || 'YOUR_EXPECTED_AUDIENCE';
const JWKS_CACHE_KEY = 'privy:jwks';
const JWKS_CACHE_TTL_SECONDS = 60 * 60; // 60 minutes
const CLOCK_SKEW_SECONDS = 30;

export class PrivyAuthService {
  private db: DrizzleD1Database;
  private kv: KVNamespace;
  private logger = getLogger().child({ component: 'PrivyAuthService' });

  constructor(env: Env) {
    this.db = drizzle(env.AUTH_DB);
    this.kv = env.AUTH_TOKENS; // Using the same KV namespace for simplicity, can be changed
  }

  private async getJwks(): Promise<Jwks> {
    const cachedJwks = await this.kv.get<Jwks>(JWKS_CACHE_KEY, 'json');
    if (cachedJwks) {
      authMetrics.counter('privy.jwks_cache.hit', 1);
      this.logger.debug('JWKS cache hit');
      return cachedJwks;
    }

    authMetrics.counter('privy.jwks_cache.miss', 1);
    this.logger.info('JWKS cache miss, fetching from Privy');
    const response = await fetch(PRIVY_JWKS_URL);
    if (!response.ok) {
      this.logger.error({ status: response.status }, 'Failed to fetch JWKS from Privy');
      throw new AuthError('Failed to fetch JWKS', AuthErrorType.JWKS_FETCH_FAILED, 500);
    }
    const jwks = (await response.json()) as Jwks;
    await this.kv.put(JWKS_CACHE_KEY, JSON.stringify(jwks), {
      expirationTtl: JWKS_CACHE_TTL_SECONDS,
    });
    return jwks;
  }

  private async getPublicKey(token: string): Promise<CryptoKey | null> {
    const decodedHeader = jose.decodeProtectedHeader(token);
    if (!decodedHeader.kid) {
      this.logger.warn('JWT KID not found in header');
      return null;
    }

    const jwks = await this.getJwks();
    const jwk = jwks.keys.find((key: Jwk) => key.kid === decodedHeader.kid && key.alg === 'ES256' && key.use === 'sig');

    if (!jwk) {
      this.logger.warn({ kid: decodedHeader.kid }, 'Matching JWK not found or invalid for ES256 signing');
      return null;
    }

    try {
      // jose.importJWK is expected to return a CryptoKey for this usage
      return (await jose.importJWK(jwk as unknown as jose.JWK)) as CryptoKey;
    } catch (error) {
      this.logger.error({ error, kid: decodedHeader.kid }, 'Failed to import JWK');
      return null;
    }
  }

  private async isJtiRevoked(jti: string, exp: number): Promise<boolean> {
    const revoked = await this.kv.get(`revoked_jti:${jti}`);
    if (revoked) {
      this.logger.warn({ jti }, 'JTI has been revoked');
      return true;
    }
    return false;
  }

  public async revokeJti(jti: string, exp: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const expirationTtl = Math.max(0, exp - now);
    if (expirationTtl > 0) {
      await this.kv.put(`revoked_jti:${jti}`, '1', { expirationTtl });
      this.logger.info({ jti, expirationTtl }, 'JTI marked as revoked');
    } else {
      this.logger.info({ jti }, 'JTI already expired, not marking as revoked');
    }
  }

  public async validatePrivyToken(token: string): Promise<ValidateTokenResponse> {
    authMetrics.counter('privy.validation.requests', 1);
    this.logger.debug('Starting Privy token validation');

    try {
      const decodedHeader = jose.decodeProtectedHeader(token);
      if (decodedHeader.alg !== 'ES256') {
        throw new AuthError(`Invalid JWT algorithm: ${decodedHeader.alg}`, AuthErrorType.INVALID_TOKEN_FORMAT, 400);
      }

      // 1. Check revocation status (JTI)
      const temporaryDecoded = jose.decodeJwt(token) as PrivyClaims; // Decode to get jti and exp for revocation check
      if (!temporaryDecoded.jti || typeof temporaryDecoded.exp !== 'number') {
          this.logger.warn({ jti: temporaryDecoded.jti, exp: temporaryDecoded.exp }, 'JWT missing jti or exp claim, or exp is not a number');
          return { success: false, user: null };
      }
      if (await this.isJtiRevoked(temporaryDecoded.jti, temporaryDecoded.exp)) {
        this.logger.warn({ jti: temporaryDecoded.jti }, 'Token JTI has been revoked');
        return { success: false, user: null };
      }

      // 2. Get Public Key
      const publicKey = await this.getPublicKey(token);
      if (!publicKey) {
        this.logger.error('Failed to get public key for Privy token verification');
        return { success: false, user: null };
      }

      // 3. Verify Signature and Claims
      const { payload } = await jose.jwtVerify(token, publicKey, {
        issuer: PRIVY_ISSUER,
        audience: EXPECTED_AUDIENCE,
        algorithms: ['ES256'],
        clockTolerance: `${CLOCK_SKEW_SECONDS}s`,
      });

      const claims = payload as PrivyClaims;

      // Additional check for nbf if present
      if (claims.nbf && (claims.nbf > (Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS))) {
        this.logger.warn({ nbf: claims.nbf, now: Math.floor(Date.now() / 1000) }, 'Token not yet valid (nbf)');
        return { success: false, user: null };
      }
      
      // 4. Map or Create User
      const user = await this.mapOrCreateUser(claims);

      const now = Math.floor(Date.now() / 1000);
      const ttl = claims.exp ? claims.exp - now : undefined;

      if (ttl !== undefined && ttl <= 0) {
        this.logger.warn({ userId: user.id, exp: claims.exp }, 'Privy token expired');
        return { success: false, user, ttl: 0 }; // Return user for context if needed, but mark as failed
      }

      authMetrics.counter('privy.validation.success', 1);
      this.logger.info({ userId: user.id, privyAppId: claims.aud, ttl }, 'Privy token validation successful');
      return {
        success: true,
        user,
        ttl,
      };
    } catch (error) {
      authMetrics.counter('privy.validation.failure', 1);
      this.logger.error({ error }, 'Privy token validation failed');
      
      if (error instanceof jose.errors.JWTExpired) {
        this.logger.warn('Privy token expired (caught by jose)');
        return { success: false, user: null, ttl: 0 };
      }
      if (error instanceof jose.errors.JOSEError) { // Catch other jose errors
         this.logger.warn({ error: error.message, code: error.code }, 'Privy JWT validation error (JOSE)');
        return { success: false, user: null };
      }
      if (error instanceof AuthError) {
        // For AuthErrors, we can pass them along or map them
        // For simplicity, returning a generic failure, but could be more specific
        return { success: false, user: null };
      }
      return { success: false, user: null };
    }
  }

  private async mapOrCreateUser(claims: PrivyClaims): Promise<User> {
    const privyUserId = claims.sub; // Privy User ID
    const email = claims.email; // Optional email from Privy

    if (!privyUserId) {
      throw new AuthError('Privy user ID (sub) missing in token', AuthErrorType.INVALID_TOKEN_FORMAT, 400);
    }

    // Check if a user_auth_provider entry exists for this Privy user
    let authProviderEntry = await this.db
      .select()
      .from(userAuthProviders)
      .where(
        and(
          eq(userAuthProviders.provider, 'privy'),
          eq(userAuthProviders.providerUserId, privyUserId),
        ),
      )
      .get();

    if (authProviderEntry) {
      // User link exists, fetch the user
      const existingUserWithPassword = await this.db
        .select()
        .from(users)
        .where(eq(users.id, authProviderEntry.userId))
        .get();
      if (!existingUserWithPassword) {
        // This case should ideally not happen if data is consistent
        this.logger.error({ privyUserId, authProviderId: authProviderEntry.id }, 'Auth provider link exists but user not found. Inconsistency.');
        throw new AuthError('User mapping inconsistent', AuthErrorType.INTERNAL_ERROR, 500);
      }
      // Return user without password
      const { password: _removedPassword, ...userWithoutPassword } = existingUserWithPassword;
      return userWithoutPassword as User;
    } else {
      // No existing link, need to create user and link
      // Try to find user by email if provided and verified by Privy (assuming claims.email_verified is true if present)
      let userIdToLink: string | undefined;
      let userToReturn: User | undefined;

      if (email) { // Assuming email from Privy is trustworthy for linking/creation
        const foundUserWithPassword = await this.db.select().from(users).where(eq(users.email, email)).get();
        if (foundUserWithPassword) {
          const { password: _removedPassword, ...userRecord } = foundUserWithPassword;
          userToReturn = userRecord as User;
          userIdToLink = userToReturn.id;
          this.logger.info({ email, userId: userIdToLink }, 'Found existing user by email for Privy linking');
        }
      }

      if (!userIdToLink) {
        // Create a new user
        const newUserId = uuidv4();
        const timestamp = new Date();
        const newUserRecord = {
          id: newUserId,
          // Use Privy email if available, otherwise a placeholder or handle as per requirements
          email: email || `${privyUserId}@privy-user.local`, // Placeholder email if not provided
          password: '', // No password for Privy-only users, or generate a secure random one if schema requires NOT NULL
          name: claims.name || null, // Use name from claims if available
          role: UserRole.USER,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        
        // Check if password can be empty or if schema needs it.
        // For now, assuming the schema allows an empty password or it's handled.
        // If users.password is NOT NULL and has no default, this will fail.
        // The schema shows password: text('password').notNull()
        // So we must provide a password. For external IdPs, this is usually a long random string.
        newUserRecord.password = crypto.randomUUID() + crypto.randomUUID(); // Secure random unusable password

        await this.db.insert(users).values(newUserRecord);
        userIdToLink = newUserId;
        this.logger.info({ privyUserId, newUserId, email }, 'Created new user for Privy login');
        const { password: _removedPassword, ...userWithoutPassword } = newUserRecord;
        userToReturn = userWithoutPassword as User;
      }

      // Create the user_auth_providers link
      const newAuthProviderEntry = {
        id: uuidv4(),
        userId: userIdToLink,
        provider: 'privy',
        providerUserId: privyUserId,
        email: email || null,
        linkedAt: new Date(),
      };
      await this.db.insert(userAuthProviders).values(newAuthProviderEntry);
      this.logger.info({ userId: userIdToLink, privyUserId }, 'Linked Privy account to user');
      
      if (!userToReturn) {
         // This case should only be hit if a new user was created AND userToReturn wasn't assigned the new user.
         // This implies userIdToLink must have been set by new user creation.
         const freshlyCreatedUserWithPassword = await this.db.select().from(users).where(eq(users.id, userIdToLink!)).get();
         if (!freshlyCreatedUserWithPassword) {
            this.logger.error({ userIdToLink }, "CRITICAL: Failed to retrieve newly created user immediately after creation.");
            throw new AuthError('Failed to retrieve newly created user', AuthErrorType.INTERNAL_ERROR, 500);
         }
         const { password: _removedPassword, ...userRecord } = freshlyCreatedUserWithPassword;
         return userRecord as User;
      }
      
      return userToReturn;
    }
  }
}