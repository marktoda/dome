import { getLogger, logError, trackOperation } from '@dome/common';
import { withContext } from '@dome/common';

// Use type reference for DomeError without importing it
type DomeError = {
  message: string;
  code?: string;
  details?: Record<string, any>;
};

/**
 * Wraps a function call with logging context specific to a service.
 * Provides enhanced error handling and structured logging.
 *
 * @param serviceName The name of the service for logging and error context
 * @param meta Metadata to include with logs (operation name, IDs, etc.)
 * @param fn The function to execute within this context
 * @returns The result of the function execution
 */
export function createServiceWrapper(serviceName: string) {
  // Import at runtime to avoid circular dependencies
  const { toDomeError } = require('@dome/errors');
  
  return async function wrap<T>(
    meta: Record<string, unknown>, 
    fn: () => Promise<T>
  ): Promise<T> {
    // Extract operation name if present for better error context
    const operation = meta.operation || meta.op || 'unknown_operation';
    
    return withContext(Object.assign({}, meta, { service: serviceName }), async (logger) => {
      try {
        // If this is a named operation with no specific tracking, use trackOperation
        if (typeof operation === 'string' && !meta.skipTracking) {
          return await trackOperation(
            `${serviceName}.${operation}`,
            fn,
            // Filter out operation from context to avoid duplication
            Object.entries(meta)
              .filter(([key]) => key !== 'operation' && key !== 'op')
              .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {})
          );
        }
        
        // Otherwise just run the function
        return await fn();
      } catch (err) {
        // Get toDomeError at runtime
        const { toDomeError } = require('@dome/errors');
        
        // Convert to DomeError for consistent handling
        const domeError = err && typeof err === 'object' &&
                         'code' in err && 'message' in err
          ? err
          : toDomeError(
              err,
              `Error in ${serviceName} service${operation ? ` during ${operation}` : ''}`,
              // Include original metadata as error context
              meta as Record<string, any>
            );
        
        // Log the error with structured format
        logError(
          domeError,
          `${serviceName} service error${operation ? ` during ${operation}` : ''}`,
          meta as Record<string, any>
        );
        
        // Rethrow the converted error
        throw domeError;
      }
    });
  };
}

/**
 * Break down a complex input-output function into smaller parts
 * with proper error handling and logging.
 * 
 * @param options Configuration options
 * @param options.serviceName The name of the service
 * @param options.operation The operation name for logging
 * @param options.inputValidation Optional function to validate inputs
 * @param options.process The main processing function
 * @param options.outputValidation Optional function to validate outputs
 * @returns A function that chains all the steps with proper error handling
 */
export function createProcessChain<TInput, TOutput>(options: {
  serviceName: string;
  operation: string;
  inputValidation?: (input: TInput) => void;
  process: (input: TInput) => Promise<TOutput>;
  outputValidation?: (output: TOutput) => void;
}) {
  const { serviceName, operation, inputValidation, process, outputValidation } = options;
  const wrapper = createServiceWrapper(serviceName);
  
  return async function processWithLogging(input: TInput): Promise<TOutput> {
    // Create metadata for logging
    const meta = { operation, input: typeof input === 'object' ? { ...input } : input };
    
    return wrapper(meta, async () => {
      // Step 1: Validate input if validation function provided
      if (inputValidation) {
        inputValidation(input);
      }
      
      // Step 2: Process the input
      const output = await process(input);
      
      // Step 3: Validate output if validation function provided
      if (outputValidation) {
        outputValidation(output);
      }
      
      return output;
    });
  };
}