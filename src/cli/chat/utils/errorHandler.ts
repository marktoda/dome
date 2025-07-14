interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 2,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffFactor = 2,
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt === maxRetries) {
        break;
      }

      // Wait with exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffFactor, maxDelay);
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

export function createErrorMessage(error: unknown, context: string): string {
  if (error instanceof Error) {
    // Network errors
    if (error.message.includes('ECONNREFUSED')) {
      return `${context}: Connection refused. Please check your network connection.`;
    }
    if (error.message.includes('ETIMEDOUT')) {
      return `${context}: Request timed out. Please try again.`;
    }
    if (error.message.includes('ENOTFOUND')) {
      return `${context}: Server not found. Please check your configuration.`;
    }
    
    // File system errors
    if (error.message.includes('ENOENT')) {
      return `${context}: File or directory not found.`;
    }
    if (error.message.includes('EACCES')) {
      return `${context}: Permission denied.`;
    }
    if (error.message.includes('ENOSPC')) {
      return `${context}: Not enough disk space.`;
    }
    
    return `${context}: ${error.message}`;
  }
  
  return `${context}: Unknown error occurred`;
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  
  const retryableMessages = [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNRESET',
    'EPIPE',
    'rate limit',
    'too many requests',
    '429',
    '503',
    '504',
  ];
  
  const message = error.message.toLowerCase();
  return retryableMessages.some(msg => message.includes(msg.toLowerCase()));
}