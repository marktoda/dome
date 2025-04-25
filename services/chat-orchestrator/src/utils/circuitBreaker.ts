import { getLogger } from '@dome/logging';

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation, requests pass through
  OPEN = 'OPEN',         // Circuit is open, requests fail fast
  HALF_OPEN = 'HALF_OPEN', // Testing if the service is back online
}

/**
 * Circuit breaker options
 */
export interface CircuitBreakerOptions {
  name: string;                 // Name of the circuit breaker
  failureThreshold: number;     // Number of failures before opening the circuit
  resetTimeout: number;         // Time in ms before trying to close the circuit again
  halfOpenSuccessThreshold?: number; // Number of successes in half-open state before closing
  timeout?: number;             // Timeout for function execution in ms
  fallbackFn?: (...args: any[]) => any; // Fallback function to call when circuit is open
  monitorIntervalMs?: number;   // Interval to log circuit status
}

/**
 * Circuit breaker status
 */
export interface CircuitBreakerStatus {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  lastReset: Date | null;
  totalFailures: number;
  totalSuccesses: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

/**
 * Circuit breaker implementation for resilient service calls
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private lastFailure: Date | null = null;
  private lastSuccess: Date | null = null;
  private lastReset: Date | null = null;
  private resetTimer: NodeJS.Timeout | null = null;
  private totalFailures: number = 0;
  private totalSuccesses: number = 0;
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private monitorInterval: NodeJS.Timeout | null = null;
  private logger = getLogger();

  constructor(private options: CircuitBreakerOptions) {
    this.logger = getLogger().child({ 
      component: 'CircuitBreaker', 
      circuit: options.name 
    });
    
    this.logger.info(
      { 
        name: options.name,
        failureThreshold: options.failureThreshold,
        resetTimeout: options.resetTimeout,
        halfOpenSuccessThreshold: options.halfOpenSuccessThreshold || 1,
        timeout: options.timeout,
      },
      'Circuit breaker initialized'
    );
    
    // Start monitoring interval if specified
    if (options.monitorIntervalMs) {
      this.monitorInterval = setInterval(() => {
        this.logStatus();
      }, options.monitorIntervalMs);
    }
  }

  /**
   * Execute a function with circuit breaker protection
   * @param fn Function to execute
   * @param args Arguments to pass to the function
   * @returns Promise resolving to the function result
   */
  async execute<T>(fn: (...args: any[]) => Promise<T>, ...args: any[]): Promise<T> {
    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      this.logger.warn('Circuit is OPEN, failing fast');
      
      // If fallback function is provided, call it
      if (this.options.fallbackFn) {
        return this.options.fallbackFn(...args);
      }
      
      throw new Error(`Circuit ${this.options.name} is open`);
    }

    try {
      // Execute the function with timeout if specified
      let result: T;
      
      if (this.options.timeout) {
        result = await this.executeWithTimeout(fn, this.options.timeout, ...args);
      } else {
        result = await fn(...args);
      }
      
      // Handle success
      this.handleSuccess();
      return result;
    } catch (error) {
      // Handle failure
      this.handleFailure(error);
      
      // If fallback function is provided, call it
      if (this.options.fallbackFn) {
        return this.options.fallbackFn(...args);
      }
      
      // Otherwise, rethrow the error
      throw error;
    }
  }

  /**
   * Execute a function with a timeout
   * @param fn Function to execute
   * @param timeoutMs Timeout in milliseconds
   * @param args Arguments to pass to the function
   * @returns Promise resolving to the function result
   */
  private async executeWithTimeout<T>(
    fn: (...args: any[]) => Promise<T>,
    timeoutMs: number,
    ...args: any[]
  ): Promise<T> {
    return Promise.race([
      fn(...args),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  /**
   * Handle successful execution
   */
  private handleSuccess(): void {
    this.lastSuccess = new Date();
    this.totalSuccesses++;
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      
      // Check if we've reached the success threshold to close the circuit
      const threshold = this.options.halfOpenSuccessThreshold || 1;
      
      if (this.successes >= threshold) {
        this.closeCircuit();
      }
    }
  }

  /**
   * Handle execution failure
   * @param error Error that occurred
   */
  private handleFailure(error: any): void {
    this.lastFailure = new Date();
    this.totalFailures++;
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    
    this.logger.error(
      { 
        err: error,
        state: this.state,
        consecutiveFailures: this.consecutiveFailures,
      },
      'Circuit execution failed'
    );
    
    if (this.state === CircuitState.CLOSED) {
      this.failures++;
      
      // Check if we've reached the failure threshold to open the circuit
      if (this.failures >= this.options.failureThreshold) {
        this.openCircuit();
      }
    } else if (this.state === CircuitState.HALF_OPEN) {
      // If we fail during half-open state, go back to open
      this.openCircuit();
    }
  }

  /**
   * Open the circuit
   */
  private openCircuit(): void {
    if (this.state !== CircuitState.OPEN) {
      this.state = CircuitState.OPEN;
      this.lastReset = new Date();
      
      this.logger.warn(
        { 
          failures: this.failures,
          consecutiveFailures: this.consecutiveFailures,
          totalFailures: this.totalFailures,
        },
        'Circuit OPENED'
      );
      
      // Set timer to try half-open state
      this.resetTimer = setTimeout(() => {
        this.halfOpenCircuit();
      }, this.options.resetTimeout);
    }
  }

  /**
   * Set circuit to half-open state
   */
  private halfOpenCircuit(): void {
    this.state = CircuitState.HALF_OPEN;
    this.failures = 0;
    this.successes = 0;
    
    this.logger.info('Circuit HALF-OPEN - testing service availability');
  }

  /**
   * Close the circuit
   */
  private closeCircuit(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastReset = new Date();
    
    this.logger.info(
      { 
        consecutiveSuccesses: this.consecutiveSuccesses,
        totalSuccesses: this.totalSuccesses,
      },
      'Circuit CLOSED'
    );
  }

  /**
   * Force the circuit to a specific state
   * @param state Circuit state to set
   */
  forceState(state: CircuitState): void {
    this.state = state;
    
    if (state === CircuitState.CLOSED) {
      this.failures = 0;
      this.successes = 0;
    } else if (state === CircuitState.OPEN && this.resetTimer === null) {
      // Set timer to try half-open state
      this.resetTimer = setTimeout(() => {
        this.halfOpenCircuit();
      }, this.options.resetTimeout);
    }
    
    this.logger.info({ state }, 'Circuit state forced');
  }

  /**
   * Reset the circuit breaker
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastReset = new Date();
    
    // Clear any existing reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    
    this.logger.info('Circuit reset');
  }

  /**
   * Get the current circuit breaker status
   * @returns Circuit breaker status
   */
  getStatus(): CircuitBreakerStatus {
    return {
      name: this.options.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      lastReset: this.lastReset,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
    };
  }

  /**
   * Log the current circuit breaker status
   */
  logStatus(): void {
    this.logger.info(
      {
        state: this.state,
        failures: this.failures,
        successes: this.successes,
        totalFailures: this.totalFailures,
        totalSuccesses: this.totalSuccesses,
        consecutiveFailures: this.consecutiveFailures,
        consecutiveSuccesses: this.consecutiveSuccesses,
      },
      'Circuit status'
    );
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }
}

/**
 * Global circuit breakers registry
 */
const circuitBreakers: Record<string, CircuitBreaker> = {};

/**
 * Get or create a circuit breaker
 * @param options Circuit breaker options
 * @returns Circuit breaker instance
 */
export function getCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  if (!circuitBreakers[options.name]) {
    circuitBreakers[options.name] = new CircuitBreaker(options);
  }
  
  return circuitBreakers[options.name];
}

/**
 * Get all circuit breakers
 * @returns Record of circuit breakers
 */
export function getAllCircuitBreakers(): Record<string, CircuitBreaker> {
  return { ...circuitBreakers };
}

/**
 * Get status of all circuit breakers
 * @returns Record of circuit breaker statuses
 */
export function getAllCircuitBreakerStatuses(): Record<string, CircuitBreakerStatus> {
  const statuses: Record<string, CircuitBreakerStatus> = {};
  
  for (const [name, circuitBreaker] of Object.entries(circuitBreakers)) {
    statuses[name] = circuitBreaker.getStatus();
  }
  
  return statuses;
}

/**
 * Reset all circuit breakers
 */
export function resetAllCircuitBreakers(): void {
  Object.values(circuitBreakers).forEach(circuitBreaker => circuitBreaker.reset());
  getLogger().info('All circuit breakers reset');
}