/**
 * @dome/logging Basic Usage Examples
 * 
 * This file demonstrates the fundamental patterns for using the @dome/logging package
 * including context propagation, different log levels, error handling, and metrics.
 */

import { 
  withLogger,
  getLogger, 
  logError, 
  createServiceMetrics,
  trackOperation,
  sanitizeForLogging,
  LogEvent,
  logOperationStart,
  logOperationSuccess,
  logOperationFailure,
  trackedFetch
} from '../src';

// -------------------------------------------------
// Basic Logger Usage
// -------------------------------------------------

// Example worker with different entry points
export default {
  // Example: Fetch handler with logging context
  async fetch(request: Request, env: any, ctx: any) {
    // Create a logging context for this request
    return withLogger(
      {
        service: 'example-api',
        component: 'fetch-handler', 
        requestId: request.headers.get('x-request-id') || crypto.randomUUID(),
        path: new URL(request.url).pathname,
        method: request.method
      },
      async (logger) => {
        // Log the start of request processing
        logger.info({ event: LogEvent.REQUEST_START }, 'Processing request');
        
        const startTime = performance.now();
        
        try {
          // Get data from request
          const body = await request.json().catch(() => ({}));
          logger.debug({ body: sanitizeForLogging(body) }, 'Received request body');
          
          // Process the request
          const result = await processRequest(body);
          
          // Log successful completion
          const duration = performance.now() - startTime;
          logger.info(
            { event: LogEvent.REQUEST_END, duration, status: 200 },
            `Request processed in ${duration.toFixed(2)}ms`
          );
          
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          // Log error with enhanced error extraction
          const duration = performance.now() - startTime;
          logError(error, 'Request processing failed', {
            duration,
            path: new URL(request.url).pathname,
            method: request.method
          });
          
          // Convert to appropriate response
          return new Response(JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    );
  },

  // Example: Queue handler with logging
  async queue(batch: any, env: any, ctx: any) {
    return withLogger(
      {
        service: 'example-processor',
        component: 'queue-handler',
        batchSize: batch.messages.length,
        queueName: 'example-queue'
      },
      async (logger) => {
        logger.info(
          { event: 'batch_processing_start', messageCount: batch.messages.length },
          `Starting to process ${batch.messages.length} messages`
        );
        
        // Process each message
        for (const message of batch.messages) {
          try {
            // Process individual message with its own logging context
            await processQueueMessage(message);
          } catch (error) {
            // Log errors but continue processing the batch
            logError(error, 'Failed to process queue message', { 
              messageId: message.id,
              contentType: message.contentType
            });
          }
        }
        
        logger.info(
          { event: 'batch_processing_complete', messageCount: batch.messages.length },
          `Completed processing batch of ${batch.messages.length} messages`
        );
      }
    );
  },
  
  // Example: Scheduled job with logging
  async scheduled(event: any, env: any, ctx: any) {
    return withLogger(
      {
        service: 'example-scheduler',
        component: 'cron-job',
        cronPattern: event.cron,
        scheduledTime: new Date().toISOString()
      },
      async (logger) => {
        logger.info({ event: 'scheduled_job_start' }, 'Starting scheduled job');
        
        try {
          // Run the scheduled task
          await runScheduledTask();
          logger.info({ event: 'scheduled_job_complete' }, 'Scheduled job completed successfully');
        } catch (error) {
          logError(error, 'Scheduled job failed', { cron: event.cron });
        }
      }
    );
  }
};

// -------------------------------------------------
// Downstream Functions with Logger Access
// -------------------------------------------------

/**
 * Example of a function that uses getLogger() to access the current context logger
 */
async function processRequest(data: any) {
  // Get the logger from the current context
  const logger = getLogger();
  
  logger.debug({ stage: 'validation', dataSize: JSON.stringify(data).length }, 'Validating request data');
  
  // Validate input
  if (!data.id) {
    logger.warn({ stage: 'validation', error: 'missing_id' }, 'Missing ID in request');
    throw new Error('ID is required');
  }
  
  // Process request with operation tracking
  return trackOperation(
    'data-processing',
    async () => {
      // Simulate processing
      await new Promise(resolve => setTimeout(resolve, 100));
      return { success: true, id: data.id, processed: true };
    },
    { dataId: data.id, dataType: data.type }
  );
}

/**
 * Example of processing a queue message with manual operation tracking
 */
async function processQueueMessage(message: any) {
  const operationName = 'message-processing';
  const context = { messageId: message.id, contentType: message.contentType };
  
  // Get logger from current context
  const logger = getLogger();
  
  // Manually track operation start
  logOperationStart(operationName, context);
  const startTime = performance.now();
  
  try {
    // Parse message body
    const body = JSON.parse(message.body);
    
    // Process message with different log levels
    logger.debug({ messageBody: sanitizeForLogging(body) }, 'Processing message');
    
    if (body.priority === 'high') {
      logger.info({ priority: 'high' }, 'Processing high priority message');
    }
    
    // Simulate API call with automatic tracking
    const apiResponse = await trackedFetch(
      'https://api.example.com/process',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      { operation: 'external-api-call', messageId: message.id }
    );
    
    if (!apiResponse.ok) {
      throw new Error(`API responded with status ${apiResponse.status}`);
    }
    
    // Log operation success
    const duration = performance.now() - startTime;
    logOperationSuccess(operationName, duration, context);
    
    return await apiResponse.json();
  } catch (error) {
    // Log operation failure
    logOperationFailure(operationName, error, context);
    throw error;
  }
}

/**
 * Example of a scheduled task with metrics
 */
async function runScheduledTask() {
  const logger = getLogger();
  const metrics = createServiceMetrics('scheduler');
  
  logger.info({ task: 'data-cleanup' }, 'Starting data cleanup');
  
  // Track metrics for the operation
  const timer = metrics.startTimer('data.cleanup.duration');
  
  try {
    // Simulate cleanup steps
    const itemsScanned = 1000;
    const itemsDeleted = 50;
    
    // Record metrics
    metrics.counter('data.cleanup.scanned', itemsScanned);
    metrics.counter('data.cleanup.deleted', itemsDeleted);
    metrics.gauge('data.cleanup.deletion_ratio', itemsDeleted / itemsScanned);
    
    logger.info(
      { itemsScanned, itemsDeleted, ratio: itemsDeleted / itemsScanned },
      `Cleanup complete: deleted ${itemsDeleted} of ${itemsScanned} items`
    );
    
    // Track operation success
    metrics.trackOperation('data.cleanup', true);
  } catch (error) {
    // Track operation failure
    metrics.trackOperation('data.cleanup', false);
    throw error;
  } finally {
    // Stop timer regardless of success/failure
    timer.stop();
  }
}

/**
 * Example of a function with try/catch and error logging
 */
async function riskyOperation(id: string) {
  try {
    // Operation that might fail
    if (!id) {
      throw new Error('ID is required');
    }
    
    if (id === 'invalid') {
      const customError = new Error('Invalid ID format');
      (customError as any).code = 'INVALID_FORMAT';
      (customError as any).statusCode = 400;
      throw customError;
    }
    
    return { success: true, id };
  } catch (error) {
    // Log with enhanced error extraction
    logError(error, 'Risky operation failed', { 
      operationId: 'risky-op-123',
      id
    });
    
    // Rethrow to let caller handle it
    throw error;
  }
}
