import { z } from 'zod';
import { NewContentMessage } from '@dome/common';
import { toDomeError } from '@dome/common';
import { domeAssertExists as assertExists } from '@dome/common/errors';
import {
  getLogger,
  logError,
  trackOperation,
  aiProcessorMetrics,
} from '../utils/logging';
import { ReprocessRequestSchema } from '../types';

export async function reprocess(this: any, data: z.infer<typeof ReprocessRequestSchema>) {
  const requestId = crypto.randomUUID();

  return trackOperation(
    'reprocess_content',
    async () => {
      try {
        const validatedData = ReprocessRequestSchema.parse(data);
        const { id } = validatedData;

        if (id) {
          getLogger().info(
            { requestId, id, operation: 'reprocess_content' },
            'Reprocessing specific content by ID',
          );

          const result = await reprocessById.call(this, id, requestId);

          aiProcessorMetrics.trackOperation('reprocess', true, {
            type: 'by_id',
            requestId,
          });

          return { success: true, reprocessed: result };
        } else {
          getLogger().info(
            { requestId, operation: 'reprocess_content_batch' },
            'Reprocessing all content with null or failed summary',
          );

          const result = await reprocessFailedContent.call(this, requestId);

          aiProcessorMetrics.trackOperation('reprocess', true, {
            type: 'all_failed',
            requestId,
            totalItems: String(result.total),
            successfulItems: String(result.successful),
          });

          return { success: true, reprocessed: result };
        }
      } catch (error) {
        const domeError = toDomeError(error, 'Error in reprocess operation', {
          service: 'ai-processor',
          operation: 'reprocess',
          id: (data as any).id,
          requestId,
        });

        logError(domeError, 'Failed to reprocess content');

        aiProcessorMetrics.trackOperation('reprocess', false, {
          errorType: domeError.code,
          requestId,
        });

        throw domeError;
      }
    },
    { requestId, id: (data as any).id },
  );
}

export async function reprocessById(this: any, id: string, requestId: string): Promise<{ id: string; success: boolean }> {
  return trackOperation(
    'reprocess_by_id',
    async () => {
      try {
        const metadata = await this.services.silo.getMetadataById(id);

        assertExists(metadata, `Content with ID ${id} not found`, {
          id,
          operation: 'reprocessById',
          requestId,
        });

        if (!metadata) {
          logError(
            new Error(`Metadata unexpectedly null after assertExists for ID: ${id}`),
            'Unexpected null metadata',
            { id, operation: 'reprocessById', requestId },
          );
          return { id, success: false };
        }

        const message: NewContentMessage = {
          id: metadata.id,
          userId: metadata.userId,
          category: metadata.category,
          mimeType: metadata.mimeType,
        };

        await this.services.processor.processMessage(message, requestId);

        aiProcessorMetrics.trackOperation('reprocess_by_id', true, {
          id,
          requestId,
          contentType: metadata.category || metadata.mimeType || 'unknown',
        });

        return { id, success: true };
      } catch (error) {
        const domeError = toDomeError(error, `Error reprocessing content with ID ${id}`, {
          id,
          operation: 'reprocessById',
          requestId,
        });

        logError(domeError, `Failed to reprocess content ID: ${id}`);

        aiProcessorMetrics.trackOperation('reprocess_by_id', false, {
          id,
          requestId,
          errorType: domeError.code,
        });

        return { id, success: false };
      }
    },
    { id, requestId },
  );
}

export async function reprocessFailedContent(this: any, requestId: string): Promise<{ total: number; successful: number }> {
  return trackOperation(
    'reprocess_failed_content',
    async () => {
      try {
        const failedContent = await this.services.silo.findContentWithFailedSummary();

        getLogger().info(
          { count: failedContent.length, requestId, operation: 'reprocessFailedContent' },
          'Found content with failed summaries',
        );

        let successful = 0;
        let errors = 0;

        for (const content of failedContent) {
          try {
            const message: NewContentMessage = {
              id: content.id,
              userId: content.userId,
              category: content.category,
              mimeType: content.mimeType,
            };

            await this.services.processor.processMessage(message, requestId);
            successful++;

            if (successful % 10 === 0) {
              getLogger().info(
                {
                  requestId,
                  progress: `${successful}/${failedContent.length}`,
                  percentComplete: Math.round((successful / failedContent.length) * 100),
                  operation: 'reprocessFailedContent',
                },
                'Batch reprocessing progress',
              );
            }
          } catch (error) {
            errors++;
            const domeError = toDomeError(error, `Error reprocessing content ID: ${content.id}`, {
              id: content.id,
              requestId,
              operation: 'reprocessFailedContent',
            });

            logError(domeError, `Failed to reprocess content during batch operation`);
          }
        }

        aiProcessorMetrics.trackOperation('reprocess_batch', true, {
          totalItems: String(failedContent.length),
          successfulItems: String(successful),
          failedItems: String(errors),
          requestId,
        });

        getLogger().info(
          {
            total: failedContent.length,
            successful,
            errors,
            requestId,
            successRate: failedContent.length > 0 ? Math.round((successful / failedContent.length) * 100) : 0,
            operation: 'reprocessFailedContent',
          },
          'Completed batch reprocessing of failed content',
        );

        return { total: failedContent.length, successful };
      } catch (error) {
        const domeError = toDomeError(error, 'Error reprocessing failed content batch', {
          requestId,
          operation: 'reprocessFailedContent',
        });

        logError(domeError, 'Failed to reprocess content batch');

        aiProcessorMetrics.trackOperation('reprocess_batch', false, {
          errorType: domeError.code,
          requestId,
        });

        return { total: 0, successful: 0 };
      }
    },
    { requestId },
  );
}
