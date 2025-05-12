/**
 * @file Manages JWT token generation, validation, and revocation.
 */
import * as jose from 'jose';
import { TokenSettings } from '../../config/token-config';

/**
 * Represents the payload of a JWT token.
 */
export interface TokenPayload extends jose.JWTPayload {
  userId: string;
  // Add other relevant claims like roles, permissions, etc.
  [key: string]: any; // Allow for additional custom claims
}

/**
 * Interface for a token manager.
 */
export interface TokenManager {
  /**
   * Generates an access token.
   * @param payload - The payload to include in the token.
   * @returns A promise that resolves to the generated access token string.
   */
  generateAccessToken(payload: TokenPayload): Promise<string>;

  /**
   * Generates a refresh token.
   * @param payload - The payload to include in the token (usually minimal, e.g., just userId).
   * @returns A promise that resolves to the generated refresh token string.
   */
  generateRefreshToken(payload: Pick<TokenPayload, 'userId'>): Promise<string>;

  /**
   * Verifies an access token.
   * @param token - The access token string to verify.
   * @returns A promise that resolves to the verified token payload.
   * @throws Error if the token is invalid or expired.
   */
  verifyAccessToken(token: string): Promise<TokenPayload>;

    /**
   * Verifies a refresh token.
   * @param token - The refresh token string to verify.
   * @returns A promise that resolves to the verified token payload.
   * @throws Error if the token is invalid or expired.
   */
  verifyRefreshToken(token: string): Promise<Pick<TokenPayload, 'userId'>>;


  /**
   * Decodes a token without verifying its signature.
   * Useful for inspecting token contents, but should not be trusted for authentication.
   * @param token - The token string to decode.
   * @returns The decoded token payload.
   */
  decodeToken(token: string): TokenPayload;

  /**
   * Revokes a token.
   * Note: True JWT revocation is complex and typically requires a server-side blacklist
   * or a mechanism to invalidate tokens (e.g., by changing secrets, though this invalidates all tokens).
   * This method might be a placeholder or integrate with such a system.
   * @param token - The token to revoke.
   * @returns A promise that resolves when the token is conceptually revoked.
   */
  revokeToken(token: string): Promise<void>;
}

/**
 * JWT-based implementation of the TokenManager interface.
 */
export class JwtTokenManager implements TokenManager {
  private readonly tokenSettings: TokenSettings;
  private accessTokenSecretKey: Uint8Array | null = null;
  private refreshTokenSecretKey: Uint8Array | null = null;

  constructor(tokenSettings: TokenSettings) {
    this.tokenSettings = tokenSettings;
  }

  private async getAccessTokenSecretKey(): Promise<Uint8Array> {
    if (!this.accessTokenSecretKey) {
      this.accessTokenSecretKey = new TextEncoder().encode(
        this.tokenSettings.accessTokenSecret,
      );
    }
    return this.accessTokenSecretKey;
  }

  private async getRefreshTokenSecretKey(): Promise<Uint8Array> {
    if (!this.refreshTokenSecretKey) {
      this.refreshTokenSecretKey = new TextEncoder().encode(
        this.tokenSettings.refreshTokenSecret,
      );
    }
    return this.refreshTokenSecretKey;
  }

  async generateAccessToken(payload: TokenPayload): Promise<string> {
    const secretKey = await this.getAccessTokenSecretKey();
    const jwt = await new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(this.tokenSettings.issuer)
      .setAudience(this.tokenSettings.audience)
      .setExpirationTime(this.tokenSettings.accessTokenExpiresIn)
      .sign(secretKey);
    return jwt;
  }

  async generateRefreshToken(payload: Pick<TokenPayload, 'userId'>): Promise<string> {
    const secretKey = await this.getRefreshTokenSecretKey();
    const jwt = await new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(this.tokenSettings.issuer)
      .setAudience(this.tokenSettings.audience) // Consider a different audience for refresh tokens if needed
      .setExpirationTime(this.tokenSettings.refreshTokenExpiresIn)
      .sign(secretKey);
    return jwt;
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    const secretKey = await this.getAccessTokenSecretKey();

    try {
      // Log the decoded protected header to inspect its content before verification
      const decodedProtectedHeader = jose.decodeProtectedHeader(token);
      console.log('TokenManager: Decoded Protected Header for verification:', JSON.stringify(decodedProtectedHeader));
    } catch (decodeError) {
      // Log if decoding the header itself fails, as this indicates a malformed token
      console.error('TokenManager: Failed to decode protected header before verification:', decodeError);
      // Decide if to throw here or let jwtVerify handle the malformed token
    }

    try {
      const { payload } = await jose.jwtVerify(token, secretKey, {
        issuer: this.tokenSettings.issuer,
        audience: this.tokenSettings.audience,
        algorithms: ['HS256'], // Explicitly state the expected algorithm
      });
      return payload as TokenPayload;
    } catch (error) {
      // Log the error or handle specific JWT errors (e.g., TokenExpiredError)
      if (error instanceof jose.errors.JWTExpired) {
        throw new Error(`Access token expired: ${error.message}`);
      }
      throw new Error(`Invalid access token: ${(error as Error).message}`);
    }
  }

  async verifyRefreshToken(token: string): Promise<Pick<TokenPayload, 'userId'>> {
    const secretKey = await this.getRefreshTokenSecretKey();
    try {
      const { payload } = await jose.jwtVerify(token, secretKey, {
        issuer: this.tokenSettings.issuer,
        audience: this.tokenSettings.audience, // Ensure audience matches if set during generation
      });
      return payload as Pick<TokenPayload, 'userId'>;
    } catch (error) {
      if (error instanceof jose.errors.JWTExpired) {
        throw new Error(`Refresh token expired: ${error.message}`);
      }
      throw new Error(`Invalid refresh token: ${(error as Error).message}`);
    }
  }

  decodeToken(token: string): TokenPayload {
    try {
      const payload = jose.decodeJwt(token);
      return payload as TokenPayload;
    } catch (error) {
      throw new Error(`Failed to decode token: ${(error as Error).message}`);
    }
  }

  async revokeToken(token: string): Promise<void> {
    // Placeholder for revocation logic.
    // In a real system, this would involve a blacklist (e.g., in Redis or a DB)
    // or other mechanisms like short-lived tokens + refresh tokens.
    // For now, we can log the intent.
    console.warn(
      `Revocation requested for token (first 10 chars): ${token.substring(
        0,
        10,
      )}... This is a conceptual operation in this basic implementation.`,
    );
    // Simulate async operation
    await Promise.resolve();
  }
}