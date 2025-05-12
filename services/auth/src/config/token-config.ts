/**
 * @file Manages configuration for authentication tokens (JWTs).
 */

/**
 * Interface for token configuration settings.
 */
export interface TokenSettings {
  /** Secret key for signing access tokens. Should be a strong, random string. */
  accessTokenSecret: string;
  /** Expiration time for access tokens, in seconds or a string like "15m", "1h", "7d". */
  accessTokenExpiresIn: string | number;
  /** Secret key for signing refresh tokens. Should be different from accessTokenSecret. */
  refreshTokenSecret: string;
  /** Expiration time for refresh tokens, in seconds or a string like "7d", "30d". */
  refreshTokenExpiresIn: string | number;
  /** Issuer claim for the JWT. */
  issuer: string;
  /** Audience claim for the JWT. */
  audience: string;
}

/**
 * Default token expiration times.
 */
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN = '15m'; // 15 minutes
const DEFAULT_REFRESH_TOKEN_EXPIRES_IN = '7d'; // 7 days
const DEFAULT_ISSUER = 'dome-auth-service';
const DEFAULT_AUDIENCE = 'dome-app';

/**
 * Retrieves token configuration settings.
 * This is a placeholder implementation. In a real application,
 * this would load configuration from environment variables, a config service,
 * or a secure vault.
 *
 * Example environment variables:
 * JWT_ACCESS_TOKEN_SECRET=your_strong_access_secret
 * JWT_ACCESS_TOKEN_EXPIRES_IN=900 # in seconds, or "15m"
 * JWT_REFRESH_TOKEN_SECRET=your_strong_refresh_secret
 * JWT_REFRESH_TOKEN_EXPIRES_IN=604800 # in seconds, or "7d"
 * JWT_ISSUER=my-app
 * JWT_AUDIENCE=my-app-clients
 *
 * @param env - The environment object, typically context.env in a Cloudflare Worker.
 * @returns Token configuration settings.
 * @throws Error if essential secret keys are not defined in the environment.
 */
export function getTokenSettings(env: any): TokenSettings {
  const accessTokenSecret = env.JWT_ACCESS_TOKEN_SECRET;
  const refreshTokenSecret = env.JWT_REFRESH_TOKEN_SECRET;

  if (!accessTokenSecret) {
    throw new Error(
      'JWT_ACCESS_TOKEN_SECRET is not defined in environment variables. This is required.',
    );
  }
  if (!refreshTokenSecret) {
    throw new Error(
      'JWT_REFRESH_TOKEN_SECRET is not defined in environment variables. This is required.',
    );
  }

  return {
    accessTokenSecret,
    accessTokenExpiresIn:
      env.JWT_ACCESS_TOKEN_EXPIRES_IN || DEFAULT_ACCESS_TOKEN_EXPIRES_IN,
    refreshTokenSecret,
    refreshTokenExpiresIn:
      env.JWT_REFRESH_TOKEN_EXPIRES_IN || DEFAULT_REFRESH_TOKEN_EXPIRES_IN,
    issuer: env.JWT_ISSUER || DEFAULT_ISSUER,
    audience: env.JWT_AUDIENCE || DEFAULT_AUDIENCE,
  };
}