/**
 * Identity Propagation Middleware
 * 
 * Middleware for downstream services to extract and use propagated identity context.
 * Works with both HTTP requests (via Hono middleware) and RPC calls.
 */
import { Context, Next } from 'hono';
import { 
  Identity, 
  decodeIdentityFromBaggage, 
  withIdentityContext, 
  encodeIdentityAsBaggage
} from '../identity';

/**
 * Configuration options for the identity propagation middleware
 */
export interface IdentityPropagationOptions {
  /** Name of the baggage header (default: 'baggage') */
  baggageHeaderName?: string;
  /** Name of the baggage query parameter (default: 'baggage') */
  baggageParamName?: string;
  /** Whether identity is required (default: false) */
  requireIdentity?: boolean;
}

/**
 * Default options for identity propagation
 */
const DEFAULT_OPTIONS: IdentityPropagationOptions = {
  baggageHeaderName: 'baggage',
  baggageParamName: 'baggage',
  requireIdentity: false
};

/**
 * Creates a Hono middleware that extracts identity from incoming requests
 * and sets up AsyncLocalStorage context using our identity library.
 * 
 * @param options Configuration options
 * @returns Hono middleware function
 */
export function createIdentityPropagationMiddleware(options: IdentityPropagationOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  return async (c: Context, next: Next) => {
    // Try baggage header first
    const baggageHeader = c.req.header(opts.baggageHeaderName || 'baggage');
    
    // Then try query parameter
    const baggageParam = c.req.query(opts.baggageParamName || 'baggage');
    
    // Use header or param, whichever is available
    const baggage = baggageHeader || baggageParam;
    
    if (baggage) {
      const identity = decodeIdentityFromBaggage(baggage);
      if (identity) {
        // Store in Hono context for easy access
        c.set('identity', identity);
        
        // Run the next middleware in the identity context
        return withIdentityContext(identity, () => next());
      }
    }
    
    // No identity found
    if (opts.requireIdentity) {
      return c.json({ error: 'Identity context required but not found' }, 401);
    }
    
    // Continue without identity context
    return next();
  };
}

/**
 * Get the current identity from the Hono context or AsyncLocalStorage
 * 
 * @param c Hono context
 * @returns Current identity or undefined if not available
 */
export function getRequestIdentity(c: Context): Identity | undefined {
  return c.get('identity');
}

/**
 * Helper to wrap RPC handler functions to extract identity from parameters
 * 
 * @param handler Original RPC handler function
 * @param options Configuration options
 * @returns Wrapped handler that sets up identity context
 */
export function withIdentityFromRPC<T, Args extends any[]>(
  handler: (...args: Args) => Promise<T>,
  options: IdentityPropagationOptions = {}
): (...args: [...Args, string?]) => Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  return async (...args: [...Args, string?]) => {
    // Check if last argument is a string (potential baggage)
    const lastArg = args.length > 0 ? args[args.length - 1] : undefined;
    const isBaggage = typeof lastArg === 'string' && lastArg.includes('uid=');
    
    if (isBaggage) {
      const baggage = lastArg as string;
      const identity = decodeIdentityFromBaggage(baggage);
      
      if (identity) {
        // Remove baggage from args
        const handlerArgs = args.slice(0, -1) as unknown as Args;
        
        // Run handler with identity context
        return withIdentityContext(identity, () => handler(...handlerArgs));
      }
    }
    
    // No valid baggage, check if identity is required
    if (opts.requireIdentity) {
      throw new Error('Identity context required but not found');
    }
    
    // Run without identity context
    return handler(...(args as unknown as Args));
  };
}

/**
 * Add identity baggage header to outgoing requests
 * 
 * @param headers Headers object to modify
 * @param identity Optional identity to encode (uses current context if not provided)
 */
export function addIdentityBaggageHeader(
  headers: Headers, 
  identity?: Identity
): void {
  try {
    // Create the baggage string from identity
    let baggage: string;
    
    if (identity) {
      baggage = encodeIdentityAsBaggage(identity);
    } else {
      // Try to get from current context
      // This will throw if no identity is in current context
      const currentIdentity = getRequestIdentity({
        get: () => undefined // Mock Hono context
      } as unknown as Context);
      
      if (currentIdentity) {
        baggage = encodeIdentityAsBaggage(currentIdentity);
      } else {
        // No identity available
        return;
      }
    }
    
    // Set the header
    headers.set('baggage', baggage);
  } catch (error) {
    // Identity not available, don't add header
  }
}