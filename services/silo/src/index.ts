/**
 * Silo Service entrypoint
 *
 * This is the main entry point for the Silo service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { getLogger, logError, metrics, trackOperation, trackedFetch } from '@dome/common';
import {
  DomeError, ValidationError, NotFoundError, toDomeError,
  assertValid, assertExists
} from '@dome/errors';
import { SiloBinding, DLQMessage, R2Event, DLQFilterOptions, DLQStats } from './types';
import { wrap } from './utils/wrap';
import { createServices, Services } from './services';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { EnrichedContentMessage, EnrichedContentMessageSchema } from '@dome/common';
import {
  siloSimplePutSchema,
  siloBatchGetSchema,
  siloDeleteSchema,
  siloStatsSchema,
  SiloBatchGetInput,
  SiloContentMetadata,
  SiloDeleteInput,
  SiloStatsInput,
  SiloContentBatch,
  SiloDeleteResponse,
  SiloStatsResponse,
} from '@dome/common';
export * from './client';

/**
 * Silo service main class
 */
export default class Silo extends WorkerEntrypoint<Env> implements SiloBinding {
  private services: Services;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    this.services = createServices(env);
  }

  /**
   * Send a message to the DLQ
   * This is a wrapper around the DLQService implementation for backward compatibility
   */
  private async sendToDLQ<T>(
    message: { body: T; id: string; retryCount?: number; attempts?: number; ack: () => void },
    error: Error,
    queueName: string,
    retryCount?: number,
  ): Promise<void> {
    // Use trackOperation to ensure consistent logging of the DLQ operation
    return trackOperation('silo.sendToDLQ', async () => {
      try {
        // Use retryCount parameter if provided, otherwise use message.retryCount or message.attempts
        const actualRetryCount = retryCount ?? message.retryCount ?? message.attempts ?? 0;
        
        // Create standard context object for consistent logging
        const context = {
          messageId: message.id,
          queueName,
          retryCount: actualRetryCount,
          errorType: error.name,
          errorMessage: error.message
        };

        await this.services.dlq.sendToDLQ(message.body, error, {
          queueName,
          messageId: message.id,
          retryCount: actualRetryCount,
        });

        // Acknowledge the original message since it's now in the DLQ
        message.ack();

        getLogger().info(
          context,
          `Message ${message.id} sent to DLQ ${queueName}`,
        );
      } catch (dlqError) {
        // Convert to DomeError for consistent error handling
        const domeError = toDomeError(
          dlqError,
          'Error sending message to DLQ',
          {
            originalErrorMessage: error.message,
            originalErrorType: error.name,
            messageId: message.id,
            queueName,
            serviceName: 'silo'
          }
        );

        // If we can't send to DLQ, log the error but still acknowledge the message
        // to prevent an infinite retry loop
        logError(
          domeError,
          'Failed to send message to DLQ, acknowledging original message anyway',
          {
            messageId: message.id,
            queueName
          }
        );
        
        // Still acknowledge to prevent retry loops
        message.ack();
        
        // Track the DLQ failure metric
        metrics.increment('silo.dlq.send_failures', 1, { queueName });
      }
    }, { messageId: message.id, queueName });
  }

  /**
   * Queue consumer for processing R2 object-created events
   */
  async queue(batch: MessageBatch<any>) {
    await wrap({ op: 'queue', queue: batch.queue, size: batch.messages.length }, async () => {
      try {
        // Determine which queue we're processing
        if (batch.queue === 'silo-content-uploaded') {
          // Process R2 events
          const promises = batch.messages.map(async message => {
            const event = message.body as R2Event;
            if (event.action === 'PutObject') {
              // Extract key from the event
              const { key } = event.object;

              // Get object metadata from R2
              const obj = await this.services.content.processR2Event(event);

              // Acknowledge the message
              message.ack();
            } else {
              getLogger().warn({ event }, 'Unsupported event action: ' + event.action);
              message.ack(); // Acknowledge anyway to avoid retries
            }
          });

          await Promise.all(promises);
        } else if (batch.queue === 'enriched-content') {
          // Process enriched content from AI processor
          const promises = batch.messages.map(async message => {
            try {
              // Validate the message
              const enrichedContent = EnrichedContentMessageSchema.parse(message.body);

              // Process the enriched content
              await this.services.content.processEnrichedContent(enrichedContent);

              // Acknowledge the message
              message.ack();
            } catch (error) {
              getLogger().error(
                { error, messageId: message.id },
                'Error processing enriched content message',
              );

              // For validation errors, send to DLQ immediately
              if (error instanceof z.ZodError) {
                await this.services.dlq.sendToDLQ(message.body, error, {
                  queueName: 'enriched-content',
                  messageId: message.id,
                  retryCount: message.attempts,
                });
                message.ack();
              } else if (message.attempts >= 3) {
                // attempts starts at 1, so 3 means 2 retries
                // If this is the final retry attempt, send to DLQ
                await this.services.dlq.sendToDLQ(message.body, error as Error, {
                  queueName: 'enriched-content',
                  messageId: message.id,
                  retryCount: message.attempts,
                });
                message.ack();
              } else {
                // Otherwise, allow retry
                throw error;
              }
            }
          });

          await Promise.all(promises);
        } else if (batch.queue === 'silo-ingest-queue') {
          // Process ingest queue messages
          const promises = batch.messages.map(async message => {
            try {
              // Validate the message
              const ingestMessage = siloSimplePutSchema.parse(message.body);

              // Process the ingest message
              await this.services.content.processIngestMessage(ingestMessage);

              // Acknowledge the message
              message.ack();
            } catch (error) {
              getLogger().error(
                { error, messageId: message.id },
                'Error processing ingest queue message',
              );

              // For validation errors, send to DLQ immediately
              if (error instanceof z.ZodError) {
                await this.services.dlq.sendToDLQ(message.body, error, {
                  queueName: 'silo-ingest-queue',
                  messageId: message.id,
                  retryCount: message.attempts,
                });
                message.ack();
              } else if (message.attempts >= 3) {
                // attempts starts at 1, so 3 means 2 retries
                // If this is the final retry attempt, send to DLQ
                await this.services.dlq.sendToDLQ(message.body, error as Error, {
                  queueName: 'silo-ingest-queue',
                  messageId: message.id,
                  retryCount: message.attempts,
                });
                message.ack();
              } else {
                // Otherwise, allow retry
                throw error;
              }
            }
          });

          await Promise.all(promises);
        } else if (batch.queue === 'ingest-dlq') {
          // Process DLQ messages
          const promises = batch.messages.map(async message => {
            try {
              // Log the DLQ message
              getLogger().info({ messageId: message.id }, 'Processing message from DLQ');

              // Just acknowledge the message for now
              // In a real implementation, we might have special handling for DLQ messages
              message.ack();
            } catch (error) {
              // Log the error but acknowledge the message to prevent infinite retries
              logError(error, 'Error processing DLQ message, acknowledging anyway', {
                messageId: message.id,
              });
              message.ack();
            }
          });

          await Promise.all(promises);
        } else {
          getLogger().warn({ queue: batch.queue }, 'Unknown queue');
        }
      } catch (error) {
        metrics.increment('silo.queue.errors', 1);
        logError(error, 'Queue processing error', { queue: batch.queue });
        throw error; // Allow retry
      }
    });
  }

  /**
   * Efficiently retrieve multiple content items
   */
  async batchGet(data: SiloBatchGetInput): Promise<SiloContentBatch> {
    return wrap({ operation: 'batchGet', inputSize: data?.ids?.length || 0 }, async () => {
      try {
        // Validate input
        const validatedData = siloBatchGetSchema.parse(data);
        
        // Add request validation metrics
        metrics.increment('silo.request.valid', 1, { method: 'batchGet' });
        
        return await this.services.content.batchGet(validatedData);
      } catch (error) {
        if (error instanceof z.ZodError) {
          // Convert Zod errors to ValidationError with detailed context
          const errorDetails = error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
            code: e.code
          }));
          
          // Create a structured ValidationError
          const validationError = new ValidationError(
            `Invalid batchGet request parameters`,
            {
              validationErrors: errorDetails,
              method: 'batchGet',
              inputData: JSON.stringify(data)
            },
            error
          );
          
          logError(validationError, 'Validation error in batchGet request', {
            method: 'batchGet',
            errorCount: error.errors.length
          });
          
          metrics.increment('silo.validation.errors', 1, { method: 'batchGet' });
          throw validationError;
        }
        
        // Handle other errors
        const domeError = toDomeError(
          error,
          'Failed to retrieve batch content',
          {
            method: 'batchGet',
            ids: data?.ids?.length ? data.ids.join(',') : 'none',
          }
        );
        
        // Log structured error
        logError(domeError, 'Error processing batchGet request', {
          method: 'batchGet'
        });
        
        metrics.increment('silo.rpc.errors', 1, {
          method: 'batchGet',
          errorType: domeError.code
        });
        
        throw domeError;
      }
    });
  }

  /**
   * Delete content items
   */
  async delete(data: SiloDeleteInput): Promise<SiloDeleteResponse> {
    return wrap({ operation: 'delete', id: data.id }, async () => {
      try {
        // Make sure required data is present
        assertValid(!!data, 'Delete request must include data', { method: 'delete' });
        assertValid(!!data.id, 'Delete request must include an ID', { method: 'delete' });
        
        // Validate input with schema
        const validatedData = siloDeleteSchema.parse(data);
        
        // Track valid request
        metrics.increment('silo.request.valid', 1, { method: 'delete' });
        
        // Perform the delete operation
        return await this.services.content.delete(validatedData);
      } catch (error) {
        if (error instanceof z.ZodError) {
          // Convert Zod validation errors to ValidationError
          const errorDetails = error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
            code: e.code
          }));
          
          const validationError = new ValidationError(
            `Invalid delete request parameters`,
            {
              validationErrors: errorDetails,
              method: 'delete',
              contentId: data.id
            },
            error
          );
          
          logError(validationError, 'Validation error in delete request', {
            method: 'delete',
            contentId: data.id,
            errorCount: error.errors.length
          });
          
          metrics.increment('silo.validation.errors', 1, { method: 'delete' });
          throw validationError;
        } else if (error instanceof DomeError) {
          // If already a DomeError, just add context if needed
          error.withContext({ method: 'delete', contentId: data.id });
          logError(error, `Error deleting content ${data.id}`, { method: 'delete' });
          metrics.increment('silo.rpc.errors', 1, { method: 'delete', errorType: error.code });
          throw error;
        }
        
        // Convert other errors to DomeError
        const domeError = toDomeError(
          error,
          `Failed to delete content with ID ${data.id}`,
          { method: 'delete', contentId: data.id }
        );
        
        logError(domeError, `Error deleting content ${data.id}`, { method: 'delete' });
        metrics.increment('silo.rpc.errors', 1, { method: 'delete', errorType: domeError.code });
        throw domeError;
      }
    });
  }

  /**
   * Get storage statistics
   */
  async stats(data: SiloStatsInput = {}): Promise<SiloStatsResponse> {
    return wrap({ operation: 'stats' }, async () => {
      try {
        // Validate input (empty object is fine for stats)
        siloStatsSchema.parse(data);
        
        // Track valid request
        metrics.increment('silo.request.valid', 1, { method: 'stats' });
        
        const startTime = performance.now();
        const result = await this.services.stats.getStats();
        const duration = performance.now() - startTime;
        
        // Log stats fetching time
        getLogger().info(
          {
            method: 'stats',
            duration,
            total: result.total,
            totalSize: result.totalSize
          },
          `Retrieved storage statistics in ${duration.toFixed(2)}ms`
        );
        
        // Track timing for stats retrieval
        metrics.timing('silo.stats.duration', duration, { method: 'stats' });
        
        return result;
      } catch (error) {
        if (error instanceof z.ZodError) {
          // Convert Zod validation errors
          const errorDetails = error.errors.map(e => ({
            path: e.path.join('.'),
            message: e.message,
            code: e.code
          }));
          
          const validationError = new ValidationError(
            `Invalid stats request parameters`,
            { validationErrors: errorDetails, method: 'stats' },
            error
          );
          
          logError(validationError, 'Validation error in stats request', {
            method: 'stats',
            errorCount: error.errors.length
          });
          
          metrics.increment('silo.validation.errors', 1, { method: 'stats' });
          throw validationError;
        }
        
        // Handle other errors
        const domeError = toDomeError(
          error,
          'Failed to retrieve storage statistics',
          { method: 'stats' }
        );
        
        logError(domeError, 'Error retrieving storage statistics', { method: 'stats' });
        metrics.increment('silo.rpc.errors', 1, { method: 'stats', errorType: domeError.code });
        throw domeError;
      }
    });
  }

  /**
   * Find content with null or "Content processing failed" summaries
   */
  async findContentWithFailedSummary(): Promise<SiloContentMetadata[]> {
    return wrap({ operation: 'findContentWithFailedSummary' }, async () => {
      try {
        // Track operation start
        metrics.increment('silo.request.started', 1, { method: 'findContentWithFailedSummary' });
        
        const startTime = performance.now();
        const result = await this.services.metadata.findContentWithFailedSummary();
        const duration = performance.now() - startTime;
        
        // Log success and track metrics
        getLogger().info(
          { method: 'findContentWithFailedSummary', itemCount: result.length, duration },
          `Found ${result.length} content items with failed summaries in ${duration.toFixed(2)}ms`
        );
        
        metrics.timing('silo.operation.duration', duration, { method: 'findContentWithFailedSummary' });
        metrics.increment('silo.request.success', 1, { method: 'findContentWithFailedSummary' });
        
        return result;
      } catch (error) {
        // Convert to DomeError for consistent handling
        const domeError = toDomeError(
          error,
          'Failed to find content with failed summaries',
          { method: 'findContentWithFailedSummary' }
        );
        
        // Log with enhanced context
        logError(domeError, 'Error finding content with failed summaries', {
          method: 'findContentWithFailedSummary',
          errorType: domeError.code
        });
        
        metrics.increment('silo.rpc.errors', 1, {
          method: 'findContentWithFailedSummary',
          errorType: domeError.code
        });
        
        throw domeError;
      }
    });
  }

  /**
   * Retrieve metadata for a specific content item by ID
   */
  async getMetadataById(id: string): Promise<SiloContentMetadata | null> {
    return wrap({ operation: 'getMetadataById', id }, async () => {
      try {
        // Make sure ID is provided
        assertValid(!!id, 'ID is required for getMetadataById', { method: 'getMetadataById' });
        
        // Track valid request
        metrics.increment('silo.request.valid', 1, { method: 'getMetadataById' });
        
        // Get the metadata
        const result = await this.services.metadata.getMetadataById(id);
        
        // Log the operation result
        getLogger().info(
          { 
            method: 'getMetadataById', 
            id, 
            found: !!result 
          },
          result ? 'Content metadata found' : 'Content metadata not found'
        );
        
        // Track operation result
        metrics.increment('silo.request.success', 1, { 
          method: 'getMetadataById', 
          found: result ? 'true' : 'false' 
        });
        
        return result;
      } catch (error) {
        // Handle errors
        const domeError = toDomeError(
          error,
          `Failed to get metadata for content with ID ${id}`,
          { method: 'getMetadataById', contentId: id }
        );
        
        // Log structured error
        logError(domeError, 'Error in getMetadataById', {
          method: 'getMetadataById',
          contentId: id
        });
        
        metrics.increment('silo.rpc.errors', 1, {
          method: 'getMetadataById',
          errorType: domeError.code
        });
        
        throw domeError;
      }
    });
  }

  /**
   * Get DLQ statistics
   */
  async dlqStats(): Promise<DLQStats> {
    return wrap({ operation: 'dlqStats' }, async () => {
      try {
        // Track operation start
        metrics.increment('silo.request.started', 1, { method: 'dlqStats' });
        
        const startTime = performance.now();
        const result = await this.services.dlq.getStats();
        const duration = performance.now() - startTime;
        
        // Log success
        getLogger().info(
          {
            method: 'dlqStats',
            duration,
            totalMessages: result.totalMessages,
            pendingMessages: result.pendingMessages,
            queueCount: Object.keys(result.byQueueName).length
          },
          `DLQ statistics retrieved in ${duration.toFixed(2)}ms`
        );
        
        // Track metrics
        metrics.timing('silo.operation.duration', duration, { method: 'dlqStats' });
        metrics.increment('silo.request.success', 1, { method: 'dlqStats' });
        
        return result;
      } catch (error) {
        // Convert to DomeError for consistent handling
        const domeError = toDomeError(
          error,
          'Failed to retrieve DLQ statistics',
          { method: 'dlqStats' }
        );
        
        // Log with enhanced context
        logError(domeError, 'Error retrieving DLQ statistics', {
          method: 'dlqStats',
          errorType: domeError.code
        });
        
        metrics.increment('silo.rpc.errors', 1, {
          method: 'dlqStats',
          errorType: domeError.code
        });
        
        throw domeError;
      }
    });
  }

  /**
   * Get DLQ messages with optional filtering
   */
  async dlqMessages(options: DLQFilterOptions = {}): Promise<DLQMessage<unknown>[]> {
    return wrap({ operation: 'dlqMessages', options: JSON.stringify(options) }, async () => {
      try {
        // Track operation start
        metrics.increment('silo.request.started', 1, { method: 'dlqMessages' });
        
        // Create a context object for logging the filter options
        const filterContext = {
          queueName: options.queueName || 'all',
          errorType: options.errorType || 'all',
          reprocessed: options.reprocessed !== undefined ? options.reprocessed : 'all',
          startDate: options.startDate || 'any',
          endDate: options.endDate || 'any',
          limit: options.limit || 'default',
          offset: options.offset || 0
        };
        
        // Log the filter options
        getLogger().info(
          { method: 'dlqMessages', filters: filterContext },
          'Retrieving DLQ messages with filters'
        );
        
        const startTime = performance.now();
        const messages = await this.services.dlq.getMessages(options);
        const duration = performance.now() - startTime;
        
        // Log success with count and duration
        getLogger().info(
          {
            method: 'dlqMessages',
            messageCount: messages.length,
            duration,
            filters: filterContext
          },
          `Retrieved ${messages.length} DLQ messages in ${duration.toFixed(2)}ms`
        );
        
        metrics.timing('silo.operation.duration', duration, { method: 'dlqMessages' });
        metrics.increment('silo.request.success', 1, { method: 'dlqMessages' });
        
        return messages;
      } catch (error) {
        // Convert to DomeError for consistent handling
        const domeError = toDomeError(
          error,
          'Failed to retrieve DLQ messages',
          {
            method: 'dlqMessages',
            filters: JSON.stringify(options)
          }
        );
        
        // Log with enhanced context
        logError(domeError, 'Error retrieving DLQ messages', {
          method: 'dlqMessages',
          errorType: domeError.code
        });
        
        metrics.increment('silo.rpc.errors', 1, {
          method: 'dlqMessages',
          errorType: domeError.code
        });
        
        throw domeError;
      }
    });
  }

  /**
   * Reprocess a specific DLQ message
   */
  async dlqReprocess(id: string): Promise<string> {
    return wrap({ operation: 'dlqReprocess', id }, async () => {
      try {
        // Track operation start
        metrics.increment('silo.request.started', 1, { method: 'dlqReprocess' });
        
        // Validate input
        assertValid(!!id, 'DLQ message ID is required for reprocessing', { 
          method: 'dlqReprocess' 
        });
        
        getLogger().info(
          { method: 'dlqReprocess', messageId: id },
          'Reprocessing DLQ message'
        );
        
        const startTime = performance.now();
        const result = await this.services.dlq.reprocessMessage(id);
        const duration = performance.now() - startTime;
        
        // Log success
        getLogger().info(
          {
            method: 'dlqReprocess',
            messageId: id,
            result,
            duration
          },
          `DLQ message reprocessed in ${duration.toFixed(2)}ms with result: ${result}`
        );
        
        metrics.timing('silo.operation.duration', duration, { method: 'dlqReprocess' });
        metrics.increment('silo.request.success', 1, { method: 'dlqReprocess' });
        metrics.increment('silo.dlq.reprocessed', 1);
        
        return result;
      } catch (error) {
        // Convert to DomeError for consistent handling
        const domeError = toDomeError(
          error,
          `Failed to reprocess DLQ message ${id}`,
          {
            method: 'dlqReprocess',
            messageId: id
          }
        );
        
        // Log with enhanced context
        logError(domeError, 'Error reprocessing DLQ message', {
          method: 'dlqReprocess',
          messageId: id,
          errorType: domeError.code
        });
        
        metrics.increment('silo.rpc.errors', 1, {
          method: 'dlqReprocess',
          errorType: domeError.code
        });
        
        throw domeError;
      }
    });
  }

  /**
   * Purge DLQ messages with optional filtering
   */
  async dlqPurge(options: DLQFilterOptions = {}): Promise<number> {
    return wrap({ operation: 'dlqPurge', options: JSON.stringify(options) }, async () => {
      try {
        // Track operation start
        metrics.increment('silo.request.started', 1, { method: 'dlqPurge' });
        
        // Create a context object for logging the filter options
        const filterContext = {
          queueName: options.queueName || 'all',
          errorType: options.errorType || 'all',
          reprocessed: options.reprocessed !== undefined ? options.reprocessed : 'all',
          startDate: options.startDate || 'any',
          endDate: options.endDate || 'any'
        };
        
        // Log the filter options
        getLogger().info(
          { method: 'dlqPurge', filters: filterContext },
          'Purging DLQ messages with filters'
        );
        
        const startTime = performance.now();
        const purgedCount = await this.services.dlq.purgeMessages(options);
        const duration = performance.now() - startTime;
        
        // Log success with count
        getLogger().info(
          {
            method: 'dlqPurge',
            duration,
            purgedCount,
            filters: filterContext
          },
          `Purged ${purgedCount} DLQ messages in ${duration.toFixed(2)}ms`
        );
        
        metrics.timing('silo.operation.duration', duration, { method: 'dlqPurge' });
        metrics.increment('silo.request.success', 1, { method: 'dlqPurge' });
        metrics.increment('silo.dlq.purged', purgedCount, {
          queue: filterContext.queueName,
          reprocessed: String(filterContext.reprocessed)
        });
        
        return purgedCount;
      } catch (error) {
        // Convert to DomeError for consistent handling
        const domeError = toDomeError(
          error,
          'Failed to purge DLQ messages',
          {
            method: 'dlqPurge',
            filters: JSON.stringify(options)
          }
        );
        
        logError(domeError, 'Error purging DLQ messages', {
          method: 'dlqPurge',
          errorType: domeError.code
        });
        
        metrics.increment('silo.rpc.errors', 1, {
          method: 'dlqPurge',
          errorType: domeError.code
        });
        
        throw domeError;
      }
    });
  }

  /**
   * Admin endpoint to reprocess specific content items
   * Takes a list of content IDs and re-publishes them to constellation and ai-processor services
   */
  async reprocessContent(contentIds: string[]): Promise<{ reprocessed: number }> {
    return wrap({ operation: 'reprocessContent', contentCount: contentIds.length }, async () => {
      try {
        // Track operation start
        metrics.increment('silo.request.started', 1, { method: 'reprocessContent' });
        
        const startTime = performance.now();
        
        // Log operation start
        getLogger().info(
          { operation: 'reprocessContent', contentIds },
          `Starting reprocessing operation for ${contentIds.length} content items`
        );
        
        // Validate input
        if (!contentIds || contentIds.length === 0) {
          getLogger().warn(
            { operation: 'reprocessContent' },
            'No content IDs provided for reprocessing'
          );
          return { reprocessed: 0 };
        }
        
        // Get content metadata for the provided IDs
        const contentItems = await this.services.metadata.getMetadataByIds(contentIds);
        
        getLogger().info(
          { 
            operation: 'reprocessContent', 
            requestedCount: contentIds.length,
            foundCount: contentItems.length 
          },
          `Found ${contentItems.length} of ${contentIds.length} requested content items`
        );
        
        // Process each content item
        let reprocessedCount = 0;
        let errorCount = 0;
        
        // Iterate through content items to reprocess
        for (const item of contentItems) {
          try {
            // Use ContentController.processR2Event to reprocess the content
            // This will trigger sending to both constellation and ai-processor
            await this.services.content.processR2Event({
              account: 'reprocess',
              bucket: 'silo-content',
              eventTime: new Date().toISOString(),
              action: 'PutObject',
              object: {
                key: item.r2Key || `content/${item.id}`,
                eTag: 'reprocess',
                size: item.size,
              }
            });
            
            reprocessedCount++;
            
            // Log progress periodically
            if (reprocessedCount % 10 === 0) {
              getLogger().info(
                { 
                  operation: 'reprocessContent', 
                  reprocessed: reprocessedCount,
                  total: contentItems.length,
                  progress: `${((reprocessedCount / contentItems.length) * 100).toFixed(1)}%`
                },
                `Reprocessed ${reprocessedCount}/${contentItems.length} content items`
              );
            }
          } catch (itemError) {
            errorCount++;
            logError(
              itemError,
              `Error reprocessing content item ${item.id}`,
              { 
                method: 'reprocessContent',
                contentId: item.id,
                userId: item.userId
              }
            );
            metrics.increment('silo.reprocess.item_errors', 1);
          }
        }
        
        const duration = performance.now() - startTime;
        
        // Log final results
        getLogger().info(
          {
            method: 'reprocessContent',
            reprocessedCount,
            errorCount,
            requestedCount: contentIds.length,
            foundCount: contentItems.length,
            duration,
            successRate: contentItems.length > 0 
              ? `${((reprocessedCount / contentItems.length) * 100).toFixed(1)}%`
              : '0%'
          },
          `Completed reprocessing ${reprocessedCount} content items with ${errorCount} errors in ${duration.toFixed(2)}ms`
        );
        
        // Track metrics
        metrics.timing('silo.operation.duration', duration, { method: 'reprocessContent' });
        metrics.increment('silo.request.success', 1, { method: 'reprocessContent' });
        metrics.increment('silo.content.reprocessed', reprocessedCount);
        if (errorCount > 0) {
          metrics.increment('silo.content.reprocess_errors', errorCount);
        }
        
        return { reprocessed: reprocessedCount };
      } catch (error) {
        // Convert to DomeError for consistent handling
        const domeError = toDomeError(
          error,
          'Failed to reprocess content',
          { method: 'reprocessContent' }
        );
        
        // Log with enhanced context
        logError(domeError, 'Error reprocessing content', {
          method: 'reprocessContent',
          errorType: domeError.code,
          contentIds: JSON.stringify(contentIds)
        });
        
        metrics.increment('silo.rpc.errors', 1, {
          method: 'reprocessContent',
          errorType: domeError.code
        });
        
        throw domeError;
      }
    });
  }
}
