/**
 * Telegram configuration
 */
export interface TelegramConfig {
  /**
   * Telegram API ID (from my.telegram.org)
   */
  apiId: number;
  
  /**
   * Telegram API Hash (from my.telegram.org)
   */
  apiHash: string;
  
  /**
   * Service ID for identifying this service to the Telegram Auth Service
   */
  serviceId: string;
  
  /**
   * Maximum number of retries for API calls
   */
  maxRetries: number;
  
  /**
   * Delay between retries in milliseconds
   */
  retryDelay: number;
  
  /**
   * Session cache TTL in milliseconds
   */
  sessionCacheTtl: number;
}

/**
 * Get Telegram configuration from environment variables
 * @param env Environment variables
 * @returns Telegram configuration
 */
export function getTelegramConfig(env: Record<string, string | undefined>): TelegramConfig {
  // Required environment variables
  const requiredVars = [
    'TELEGRAM_API_ID',
    'TELEGRAM_API_HASH',
    'TELEGRAM_SERVICE_ID'
  ];
  
  // Check for missing required variables
  const missingVars = requiredVars.filter(varName => !env[varName]);
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
  
  return {
    apiId: parseInt(env.TELEGRAM_API_ID!, 10),
    apiHash: env.TELEGRAM_API_HASH!,
    serviceId: env.TELEGRAM_SERVICE_ID!,
    maxRetries: parseInt(env.TELEGRAM_MAX_RETRIES || '3', 10),
    retryDelay: parseInt(env.TELEGRAM_RETRY_DELAY || '2000', 10),
    sessionCacheTtl: parseInt(env.TELEGRAM_SESSION_CACHE_TTL || '300000', 10) // 5 minutes default
  };
}