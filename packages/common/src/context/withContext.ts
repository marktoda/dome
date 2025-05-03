import { als as loggerAls, baseLogger } from '@dome/logging/runtime';
import type { Logger } from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Identity, encodeIdentityAsBaggage } from '../identity';

// Create a type for the metadata that includes optional identity
type ContextMeta = Record<string, unknown> & { 
  level?: string;
  identity?: Identity;
};

/**
 * Run a function with both logger and identity context
 * 
 * This combines the functionality of withLogger from @dome/logging with
 * identity context propagation. It ensures both the logger and identity
 * are available in AsyncLocalStorage for downstream functions.
 * 
 * @param meta Metadata for the logger and optional identity
 * @param fn Function to execute with the context
 * @returns Result of the function execution
 * 
 * @example
 * ```
 * await withContext(
 *   { 
 *     component: 'MyComponent', 
 *     identity: { uid: 'user123' }
 *   },
 *   async (logger) => {
 *     // Logger is injected and identity is available in context
 *     const identity = getIdentityContext();
 *     logger.info({ userId: identity.uid }, 'Processing request');
 *     
 *     // Call other functions that use getLogger() or getIdentityContext()
 *     await doSomething();
 *   }
 * );
 * ```
 */
export async function withContext<T>(
  meta: ContextMeta, 
  fn: (log: Logger) => Promise<T> | T
): Promise<T> {
  // Extract identity if present
  const identity = meta.identity;
  
  // Create child logger with the metadata
  const child = baseLogger.child(meta, { level: meta.level });

  // If no identity, just use logger context
  if (!identity) {
    return loggerAls.run(new Map([['logger', child]]), async () => fn(child));
  }

  // Helper function to run with identity context
  // We'll nest this within the logger context
  const runWithIdentity = async (): Promise<T> => {
    // Import identity context to avoid circular dependencies
    const { identityContext } = await import('../identity');
    
    // Patch fetch to include baggage header if needed
    const originalFetch = globalThis.fetch;
    
    try {
      // Add baggage header to all outgoing fetch requests
      const baggage = encodeIdentityAsBaggage(identity);
      globalThis.fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('baggage', baggage);
        return originalFetch(input, { ...init, headers });
      };
      
      // Run the function with identity context
      return identityContext.run(identity, () => fn(child));
    } finally {
      // Restore original fetch implementation
      if (typeof globalThis.fetch !== 'undefined') {
        globalThis.fetch = originalFetch;
      }
    }
  };
  
  // Wrap everything in the logger context
  return loggerAls.run(new Map([['logger', child]]), runWithIdentity);
}