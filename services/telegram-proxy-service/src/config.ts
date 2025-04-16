import dotenv from 'dotenv';

/**
 * Application configuration
 * Loads and validates environment variables
 *
 * This module provides a centralized, type-safe configuration system for the application.
 * It loads environment variables from .env files in development mode, validates required
 * values, and provides typed access to configuration values throughout the application.
 */

// Load environment variables from .env file in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

/**
 * Environment type
 * Defines the possible environment values
 */
export type Environment = 'development' | 'staging' | 'production' | 'test';

/**
 * Server configuration interface
 */
export interface ServerConfig {
  /** The port the server will listen on */
  PORT: number;
  /** The host the server will bind to */
  HOST: string;
  /** The current environment (development, staging, production, test) */
  NODE_ENV: Environment;
  /** Whether the application is running in production mode */
  IS_PRODUCTION: boolean;
  /** Whether the application is running in development mode */
  IS_DEVELOPMENT: boolean;
  /** Whether the application is running in test mode */
  IS_TEST: boolean;
  /** Whether the application is running in staging mode */
  IS_STAGING: boolean;
}

/**
 * Logging configuration interface
 */
export interface LoggingConfig {
  /** The log level (error, warn, info, http, verbose, debug, silly) */
  LEVEL: string;
  /** The log format (json, pretty) */
  FORMAT: 'json' | 'pretty';
}

/**
 * Telegram API configuration interface
 */
export interface TelegramConfig {
  /** The Telegram API ID (required) - obtained from https://my.telegram.org/apps */
  API_ID: string | undefined;
  /** The Telegram API Hash (required) - obtained from https://my.telegram.org/apps */
  API_HASH: string | undefined;
}

/**
 * Redis configuration interface
 */
export interface RedisConfig {
  /** The Redis host */
  HOST: string;
  /** The Redis port */
  PORT: number;
  /** The Redis password (optional) */
  PASSWORD: string;
  /** The Redis database number */
  DB: number;
  /** The Redis key prefix for this service */
  PREFIX: string;
}

/**
 * Authentication configuration interface
 */
export interface AuthConfig {
  /** The secret used to sign JWT tokens (required) */
  JWT_SECRET: string;
  /** The JWT token expiration time */
  JWT_EXPIRATION: string;
}

/**
 * Rate limiting configuration interface
 */
export interface RateLimitConfig {
  /** The time window for rate limiting in milliseconds */
  WINDOW_MS: number;
  /** The maximum number of requests allowed in the time window */
  MAX_REQUESTS: number;
}

/**
 * Telegram client pool configuration interface
 */
export interface ClientPoolConfig {
  /** The minimum number of clients in the pool */
  MIN_SIZE: number;
  /** The maximum number of clients in the pool */
  MAX_SIZE: number;
  /** The timeout for acquiring a client from the pool in milliseconds */
  ACQUIRE_TIMEOUT_MS: number;
  /** The idle timeout for clients in the pool in milliseconds */
  IDLE_TIMEOUT_MS: number;
}

/**
 * Session management configuration interface
 */
export interface SessionConfig {
  /** The session time-to-live in seconds */
  TTL_SECONDS: number;
}

/**
 * Server configuration
 * Defines the server settings including port, host, and environment
 */
export const SERVER: ServerConfig = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: (process.env.NODE_ENV as Environment) || 'development',
  IS_PRODUCTION: process.env.NODE_ENV === 'production',
  IS_DEVELOPMENT: process.env.NODE_ENV === 'development',
  IS_TEST: process.env.NODE_ENV === 'test',
  IS_STAGING: process.env.NODE_ENV === 'staging',
};

/**
 * Logging configuration
 * Defines logging settings including level and format
 */
export const LOGGING: LoggingConfig = {
  LEVEL: process.env.LOG_LEVEL || 'info',
  FORMAT: (process.env.LOG_FORMAT as 'json' | 'pretty') || 'json',
};

/**
 * Telegram API configuration
 * Defines the Telegram API credentials
 */
export const TELEGRAM: TelegramConfig = {
  API_ID: process.env.TELEGRAM_API_ID,
  API_HASH: process.env.TELEGRAM_API_HASH,
};

/**
 * Redis configuration
 * Defines the Redis connection settings
 */
export const REDIS: RedisConfig = {
  HOST: process.env.REDIS_HOST || 'localhost',
  PORT: parseInt(process.env.REDIS_PORT || '6379', 10),
  PASSWORD: process.env.REDIS_PASSWORD || '',
  DB: parseInt(process.env.REDIS_DB || '0', 10),
  PREFIX: process.env.REDIS_PREFIX || 'telegram_proxy:',
};

/**
 * Authentication configuration
 * Defines the JWT settings for authentication
 */
export const AUTH: AuthConfig = {
  JWT_SECRET: process.env.JWT_SECRET || (SERVER.IS_PRODUCTION ? '' : 'development_secret_key'),
  JWT_EXPIRATION: process.env.JWT_EXPIRATION || '1h',
};

/**
 * Rate limiting configuration
 * Defines the rate limiting settings for API endpoints
 */
export const RATE_LIMIT: RateLimitConfig = {
  WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
};

/**
 * Telegram client pool configuration
 * Defines the settings for the Telegram client connection pool
 */
export const CLIENT_POOL: ClientPoolConfig = {
  MIN_SIZE: parseInt(process.env.CLIENT_POOL_MIN_SIZE || '5', 10),
  MAX_SIZE: parseInt(process.env.CLIENT_POOL_MAX_SIZE || '20', 10),
  ACQUIRE_TIMEOUT_MS: parseInt(process.env.CLIENT_POOL_ACQUIRE_TIMEOUT_MS || '5000', 10),
  IDLE_TIMEOUT_MS: parseInt(process.env.CLIENT_POOL_IDLE_TIMEOUT_MS || '300000', 10),
};

/**
 * Session management configuration
 * Defines the settings for user session management
 */
export const SESSION: SessionConfig = {
  TTL_SECONDS: parseInt(process.env.SESSION_TTL_SECONDS || '86400', 10),
};

/**
 * Complete configuration object
 * Combines all configuration sections into a single object
 */
export const config = {
  SERVER,
  LOGGING,
  TELEGRAM,
  REDIS,
  AUTH,
  RATE_LIMIT,
  CLIENT_POOL,
  SESSION,
};

/**
 * Validate required configuration
 * Ensures all required environment variables are present and valid
 *
 * @throws Error if any required configuration is missing
 */
export function validateConfig(): void {
  // Define required variables with their validation functions
  const requiredVars = [
    {
      name: 'TELEGRAM_API_ID',
      value: TELEGRAM.API_ID,
      validate: (value: any) => value !== undefined && value !== '',
    },
    {
      name: 'TELEGRAM_API_HASH',
      value: TELEGRAM.API_HASH,
      validate: (value: any) => value !== undefined && value !== '',
    },
    {
      name: 'JWT_SECRET',
      value: AUTH.JWT_SECRET,
      validate: (value: any) => {
        // In production, we must have a real JWT secret
        if (SERVER.IS_PRODUCTION) {
          return value !== undefined && value !== '' && value !== 'development_secret_key';
        }
        // In non-production, we can use the default
        return value !== undefined && value !== '';
      },
    },
  ];

  // Find missing or invalid variables
  const invalidVars = requiredVars.filter(v => !v.validate(v.value)).map(v => v.name);

  if (invalidVars.length > 0) {
    throw new Error(`Missing or invalid required environment variables: ${invalidVars.join(', ')}`);
  }
}

/**
 * Get a sanitized version of the configuration for logging
 * Removes sensitive values like passwords and secrets
 *
 * @returns A sanitized configuration object safe for logging
 */
export function getSanitizedConfig() {
  return {
    SERVER,
    LOGGING,
    TELEGRAM: {
      // Mask sensitive values
      API_ID: TELEGRAM.API_ID ? '****' : undefined,
      API_HASH: TELEGRAM.API_HASH ? '****' : undefined,
    },
    REDIS: {
      ...REDIS,
      // Mask sensitive values
      PASSWORD: REDIS.PASSWORD ? '****' : '',
    },
    AUTH: {
      // Mask sensitive values
      JWT_SECRET: AUTH.JWT_SECRET ? '****' : undefined,
      JWT_EXPIRATION: AUTH.JWT_EXPIRATION,
    },
    RATE_LIMIT,
    CLIENT_POOL,
    SESSION,
  };
}
