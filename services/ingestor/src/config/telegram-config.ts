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
  
  /**
   * Telegram Proxy Service configuration
   */
  proxy: {
    /**
     * Base URL of the Telegram Proxy Service
     */
    baseUrl: string;
    
    /**
     * API key for authentication with the Telegram Proxy Service
     */
    apiKey: string;
    
    /**
     * Whether to use the Telegram Proxy Service
     */
    enabled: boolean;
    
    /**
     * Default polling interval in milliseconds
     */
    pollingInterval: number;
    
    /**
     * Default polling timeout in seconds
     */
    pollTimeout: number;
  };
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
  
  // Check for proxy service configuration
  const proxyEnabled = env.TELEGRAM_PROXY_ENABLED !== 'false';
  
  // If proxy is enabled, check for required proxy variables
  if (proxyEnabled) {
    const requiredProxyVars = [
      'TELEGRAM_PROXY_BASE_URL',
      'TELEGRAM_PROXY_API_KEY'
    ];
    
    const missingProxyVars = requiredProxyVars.filter(varName => !env[varName]);
    if (missingProxyVars.length > 0) {
      console.warn(`Missing Telegram Proxy Service configuration: ${missingProxyVars.join(', ')}. Proxy will be disabled.`);
    }
  }
  
  return {
    apiId: parseInt(env.TELEGRAM_API_ID!, 10),
    apiHash: env.TELEGRAM_API_HASH!,
    serviceId: env.TELEGRAM_SERVICE_ID!,
    maxRetries: parseInt(env.TELEGRAM_MAX_RETRIES || '3', 10),
    retryDelay: parseInt(env.TELEGRAM_RETRY_DELAY || '2000', 10),
    sessionCacheTtl: parseInt(env.TELEGRAM_SESSION_CACHE_TTL || '300000', 10), // 5 minutes default
    proxy: {
      baseUrl: env.TELEGRAM_PROXY_BASE_URL || 'http://localhost:3000',
      apiKey: env.TELEGRAM_PROXY_API_KEY || '',
      enabled: proxyEnabled && !!env.TELEGRAM_PROXY_BASE_URL && !!env.TELEGRAM_PROXY_API_KEY,
      pollingInterval: parseInt(env.TELEGRAM_PROXY_POLLING_INTERVAL || '5000', 10), // 5 seconds default
      pollTimeout: parseInt(env.TELEGRAM_PROXY_POLL_TIMEOUT || '10', 10) // 10 seconds default
    }
  };
}