/**
 * Telegram Proxy Client Wrapper
 *
 * This client communicates with the Telegram Proxy Service instead of
 * directly connecting to Telegram, solving WebSocket compatibility issues
 * with Cloudflare Workers.
 */

/**
 * Result of sending authentication code
 */
export interface SendCodeResult {
  phoneCodeHash: string;
  isCodeViaApp: boolean;
  timeout: number;
}

/**
 * Result of verifying authentication code
 */
export interface VerifyCodeResult {
  userId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  sessionString: string;
}

/**
 * Error types for better error handling
 */
export enum ErrorType {
  NETWORK = 'NETWORK',
  RATE_LIMIT = 'RATE_LIMIT',
  PROXY_SERVICE = 'PROXY_SERVICE',
  TELEGRAM_API = 'TELEGRAM_API',
  AUTHENTICATION = 'AUTHENTICATION',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Custom error class with error type
 */
export class TelegramProxyError extends Error {
  type: ErrorType;
  retryable: boolean;

  constructor(message: string, type: ErrorType, retryable = false) {
    super(message);
    this.name = 'TelegramProxyError';
    this.type = type;
    this.retryable = retryable;
  }
}

/**
 * Circuit breaker states
 */
enum CircuitState {
  CLOSED, // Normal operation
  OPEN, // Failing, not allowing requests
  HALF_OPEN, // Testing if service is back
}

/**
 * Configuration for the Telegram Proxy Client
 */
export interface TelegramProxyClientConfig {
  proxyUrl: string;
  apiKey?: string;
  maxRetries?: number;
  retryDelay?: number;
  circuitBreaker?: {
    failureThreshold: number;
    resetTimeout: number;
  };
}

/**
 * Telegram Proxy Client Wrapper
 */
export class TelegramProxyClient {
  private config: TelegramProxyClientConfig;
  private apiId: string;
  private apiHash: string;

  // Circuit breaker state
  private circuitState: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private nextRetry = 0;

  /**
   * Constructor
   * @param apiId - Telegram API ID
   * @param apiHash - Telegram API Hash
   * @param config - Configuration options
   */
  constructor(apiId: string, apiHash: string, config: TelegramProxyClientConfig) {
    this.apiId = apiId;
    this.apiHash = apiHash;

    // Set default configuration values
    this.config = {
      maxRetries: 3,
      retryDelay: 1000,
      circuitBreaker: {
        failureThreshold: 5,
        resetTimeout: 30000, // 30 seconds
      },
      ...config,
    };
  }

  /**
   * Send authentication code to phone number
   * @param phoneNumber - The phone number to send code to
   * @returns SendCodeResult with code hash and other details
   */
  async sendAuthCode(phoneNumber: string): Promise<SendCodeResult> {
    return this.executeWithRetry(async () => {
      const response = await fetch(`${this.config.proxyUrl}/api/v1/auth/send-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          phoneNumber,
          apiId: this.apiId,
          apiHash: this.apiHash,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        this.handleErrorResponse(response, data);
      }

      if (!data.success || !data.data) {
        throw new TelegramProxyError(
          data.error?.message || 'Failed to send authentication code',
          this.mapErrorType(data.error?.code),
          this.isRetryable(data.error?.code),
        );
      }

      return {
        phoneCodeHash: data.data.phoneCodeHash,
        isCodeViaApp: data.data.isCodeViaApp || false,
        timeout: data.data.timeout || 120,
      };
    });
  }

  /**
   * Verify authentication code
   * @param phoneNumber - The phone number
   * @param phoneCodeHash - The phone code hash from sendAuthCode
   * @param code - The authentication code received by the user
   * @returns VerifyCodeResult with user details and session string
   */
  async verifyAuthCode(
    phoneNumber: string,
    phoneCodeHash: string,
    code: string,
  ): Promise<VerifyCodeResult> {
    return this.executeWithRetry(async () => {
      const response = await fetch(`${this.config.proxyUrl}/api/v1/auth/verify-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          phoneNumber,
          phoneCode: code,
          phoneCodeHash,
          apiId: this.apiId,
          apiHash: this.apiHash,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        this.handleErrorResponse(response, data);
      }

      if (!data.success || !data.data) {
        throw new TelegramProxyError(
          data.error?.message || 'Failed to verify authentication code',
          this.mapErrorType(data.error?.code),
          this.isRetryable(data.error?.code),
        );
      }

      return {
        userId: data.data.userId,
        firstName: data.data.firstName,
        lastName: data.data.lastName,
        username: data.data.username,
        sessionString: data.data.sessionString,
      };
    });
  }

  /**
   * Create a client from a session string
   * This is a placeholder that returns the session ID from the proxy service
   * The actual client operations will be performed through the proxy service
   * @param sessionString - The session string
   * @returns Session ID that can be used with the proxy service
   */
  async createClientFromSession(sessionString: string): Promise<string> {
    return this.executeWithRetry(async () => {
      const response = await fetch(`${this.config.proxyUrl}/api/v1/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          sessionString,
          apiId: this.apiId,
          apiHash: this.apiHash,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        this.handleErrorResponse(response, data);
      }

      if (!data.success || !data.data) {
        throw new TelegramProxyError(
          data.error?.message || 'Failed to create client from session',
          this.mapErrorType(data.error?.code),
          this.isRetryable(data.error?.code),
        );
      }

      return data.data.sessionId;
    });
  }

  /**
   * Execute a function with retry and circuit breaker logic
   * @param fn - The function to execute
   * @returns The result of the function
   */
  private async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.circuitState === CircuitState.OPEN) {
      if (Date.now() < this.nextRetry) {
        throw new TelegramProxyError(
          'Circuit breaker is open, too many failures',
          ErrorType.PROXY_SERVICE,
          false,
        );
      }

      // Move to half-open state
      this.circuitState = CircuitState.HALF_OPEN;
    }

    let lastError: Error | null = null;

    // Try with retries
    for (let attempt = 0; attempt <= (this.config.maxRetries || 3); attempt++) {
      try {
        const result = await fn();

        // If successful and in half-open state, close the circuit
        if (this.circuitState === CircuitState.HALF_OPEN) {
          this.closeCircuit();
        }

        return result;
      } catch (error: any) {
        lastError = error;

        // If the error is not retryable or we're out of retries
        if (!error.retryable || attempt === this.config.maxRetries) {
          this.recordFailure();
          throw error;
        }

        // Wait before retry
        const delay = this.getRetryDelay(attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // This should never happen due to the loop structure, but TypeScript needs it
    throw lastError || new Error('Unknown error during retry');
  }

  /**
   * Record a failure and potentially open the circuit
   */
  private recordFailure(): void {
    this.failures++;

    const threshold = this.config.circuitBreaker?.failureThreshold || 5;

    if (this.failures >= threshold) {
      this.openCircuit();
    }
  }

  /**
   * Open the circuit
   */
  private openCircuit(): void {
    this.circuitState = CircuitState.OPEN;
    this.nextRetry = Date.now() + (this.config.circuitBreaker?.resetTimeout || 30000);
  }

  /**
   * Close the circuit
   */
  private closeCircuit(): void {
    this.circuitState = CircuitState.CLOSED;
    this.failures = 0;
  }

  /**
   * Get the delay for a retry attempt
   * @param attempt - The current attempt number
   * @returns The delay in milliseconds
   */
  private getRetryDelay(attempt: number): number {
    // Exponential backoff with jitter
    const baseDelay = this.config.retryDelay || 1000;
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay;

    return exponentialDelay + jitter;
  }

  /**
   * Handle error response from the proxy service
   * @param response - The fetch response
   * @param data - The response data
   */
  private handleErrorResponse(
    response: Response,
    data: {
      success: boolean;
      error?: {
        code: string;
        message: string;
      };
    },
  ): never {
    let errorType = ErrorType.UNKNOWN;
    let retryable = false;

    // Determine error type based on status code
    if (response.status === 429) {
      errorType = ErrorType.RATE_LIMIT;
      retryable = true;
    } else if (response.status >= 500) {
      errorType = ErrorType.PROXY_SERVICE;
      retryable = true;
    } else if (response.status === 401 || response.status === 403) {
      errorType = ErrorType.AUTHENTICATION;
      retryable = false;
    } else if (response.status >= 400 && response.status < 500) {
      errorType = ErrorType.TELEGRAM_API;
      retryable = false;
    }

    throw new TelegramProxyError(
      data.error?.message || `HTTP error ${response.status}`,
      errorType,
      retryable,
    );
  }

  /**
   * Map error code to error type
   * @param code - The error code
   * @returns The error type
   */
  private mapErrorType(code?: string): ErrorType {
    if (!code) {
      return ErrorType.UNKNOWN;
    }

    if (code.includes('RATE_LIMIT')) {
      return ErrorType.RATE_LIMIT;
    } else if (code.includes('NETWORK')) {
      return ErrorType.NETWORK;
    } else if (code.includes('AUTH')) {
      return ErrorType.AUTHENTICATION;
    } else if (code.includes('PROXY')) {
      return ErrorType.PROXY_SERVICE;
    } else if (code.includes('TELEGRAM')) {
      return ErrorType.TELEGRAM_API;
    }

    return ErrorType.UNKNOWN;
  }

  /**
   * Determine if an error is retryable based on its code
   * @param code - The error code
   * @returns Whether the error is retryable
   */
  private isRetryable(code?: string): boolean {
    if (!code) {
      return false;
    }

    return (
      code.includes('RATE_LIMIT') ||
      code.includes('NETWORK') ||
      code.includes('TEMPORARY') ||
      code.includes('TIMEOUT')
    );
  }
}
