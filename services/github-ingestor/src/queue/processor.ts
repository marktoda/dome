import { Env, IngestMessage, DeadLetterMessage, MessageBatch, Message } from '../types';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { GitHubIngestor } from '../ingestors/github/github-ingestor';
import { ContentService } from '../services/content-service';
import { RepositoryService } from '../services/repository-service';
import { Ingestor, ItemMetadata } from '../ingestors/base';
import { getMimeType } from '../github/content-utils';

/**
 * Process a batch of messages from the ingest queue
 * @param batch Batch of messages
 * @param env Environment variables and bindings
 */
export async function processQueueBatch(
  batch: MessageBatch<IngestMessage>,
  env: Env,
): Promise<void> {
  const startTime = performance.now();
  const batchSize = batch.messages.length;

  logger().info({ batchSize }, 'Processing ingest queue batch');
  metrics.gauge('queue.batch_size', batchSize);

  // Process each message in the batch
  for (const message of batch.messages) {
    try {
      await processIngestMessage(message.body, env);
      metrics.counter('queue.message.success', 1);
    } catch (error) {
      logError(error as Error, 'Error processing ingest message', {
        messageId: message.id,
        messageType: message.body.type,
      });

      metrics.counter('queue.message.error', 1);

      // Send to dead letter queue for later analysis
      await sendToDeadLetterQueue(message.body, error as Error, env);
    }
  }

  metrics.timing('queue.batch.process_time_ms', performance.now() - startTime);
}

/**
 * Process a single ingest message
 * @param message Ingest message
 * @param env Environment variables and bindings
 */
async function processIngestMessage(message: IngestMessage, env: Env): Promise<void> {
  const { type } = message;

  logger().info({ type, message }, 'Processing ingest message');

  switch (type) {
    case 'repository':
      await processRepositoryMessage(message, env);
      break;
    case 'file':
      await processFileMessage(message, env);
      break;
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

/**
 * Process a repository ingest message
 * @param message Repository ingest message
 * @param env Environment variables and bindings
 */
async function processRepositoryMessage(message: IngestMessage, env: Env): Promise<void> {
  const {
    repoId,
    userId,
    provider,
    owner,
    repo,
    branch,
    isPrivate,
    includePatterns,
    excludePatterns,
  } = message;

  logger().info({ repoId, owner, repo, branch }, 'Processing repository ingest message');

  const startTime = performance.now();
  metrics.counter('queue.repository.processed', 1);

  try {
    // Create GitHub ingestor for this repository
    const ingestor = await GitHubIngestor.forRepository(
      repoId,
      userId,
      owner,
      repo,
      branch || 'main',
      isPrivate,
      includePatterns,
      excludePatterns,
      env,
    );

    // List all items that need to be ingested
    const items = await ingestor.listItems();
    logger().info({ repoId, owner, repo, itemCount: items.length }, 'Listed repository items');

    if (items.length === 0) {
      // No changes, just update the sync timestamp
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `
        UPDATE provider_repositories
        SET lastSyncedAt = ?, updatedAt = ?
        WHERE id = ?
      `,
      )
        .bind(now, now, repoId)
        .run();

      logger().info({ repoId, owner, repo }, 'No changes detected, updated sync timestamp');
      return;
    }

    // Process items in batches with concurrency limit
    const contentService = new ContentService(env);
    const batchSize = 5; // Process 5 items at a time

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      // Process batch in parallel
      await Promise.all(
        batch.map(async item => {
          try {
            await processItem(item, ingestor, contentService);
            metrics.counter('queue.item.processed', 1);
          } catch (error) {
            logError(error as Error, `Failed to process item ${item.path}`, {
              repoId,
              owner,
              repo,
              path: item.path,
            });
            metrics.counter('queue.item.error', 1);
          }
        }),
      );

      // Yield to avoid CPU time limit if there are more items
      if (i + batchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }

    // Update repository sync status with the last item's metadata
    // This assumes the last item has the latest commit SHA and etag
    if (items.length > 0) {
      const lastItem = items[items.length - 1];
      await ingestor.updateSyncStatus(lastItem);

      logger().info(
        { repoId, owner, repo, itemCount: items.length },
        'Processed repository items and updated sync status',
      );
    }

    metrics.timing('queue.repository.process_time_ms', performance.now() - startTime);
  } catch (error) {
    metrics.counter('queue.repository.error', 1);

    // Determine if the error is transient (should be retried)
    const isTransient = isTransientError(error as Error);

    // Record the error in the repository service
    const repoService = new RepositoryService(env);
    await repoService.recordSyncError(repoId, (error as Error).message, isTransient);

    // Rethrow to trigger retry or dead letter queue
    throw error;
  }
}

/**
 * Process a file ingest message
 * @param message File ingest message
 * @param env Environment variables and bindings
 */
async function processFileMessage(message: IngestMessage, env: Env): Promise<void> {
  const {
    repoId,
    userId,
    provider,
    owner,
    repo,
    path,
    sha,
    isPrivate,
    includePatterns,
    excludePatterns,
  } = message;

  if (!path || !sha) {
    throw new Error('File message missing required path or sha');
  }

  logger().info({ repoId, owner, repo, path, sha }, 'Processing file ingest message');

  const startTime = performance.now();
  metrics.counter('queue.file.processed', 1);

  try {
    // Create GitHub ingestor for this repository
    const ingestor = await GitHubIngestor.forRepository(
      repoId,
      userId,
      owner,
      repo,
      message.branch || 'main',
      isPrivate,
      includePatterns,
      excludePatterns,
      env,
    );

    // Create metadata for this file
    const metadata: ItemMetadata = {
      id: `${repoId}:${path}`,
      title: path.split('/').pop() || '',
      url: `https://github.com/${owner}/${repo}/blob/${message.branch || 'main'}/${path}`,
      provider: 'github',
      providerType: 'repository',
      owner,
      repository: repo,
      path,
      createdAt: new Date(),
      updatedAt: new Date(),
      size: 0, // Will be updated when content is fetched
      contentType: getMimeType(path),
      sha,
      repoId,
      userId,
    };

    // Process the file
    const contentService = new ContentService(env);
    await processItem(metadata, ingestor, contentService);

    logger().info({ repoId, path, sha }, 'Processed file successfully');

    metrics.timing('queue.file.process_time_ms', performance.now() - startTime);
  } catch (error) {
    metrics.counter('queue.file.error', 1);
    logError(error as Error, `Failed to process file ${path}`, {
      repoId,
      owner,
      repo,
      path,
    });

    // Rethrow to trigger retry or dead letter queue
    throw error;
  }
}

/**
 * Send a failed message to the dead letter queue
 * @param message Original ingest message
 * @param error Error that occurred
 * @param env Environment variables and bindings
 */
async function sendToDeadLetterQueue(
  message: IngestMessage,
  error: Error,
  env: Env,
): Promise<void> {
  const deadLetterMessage: DeadLetterMessage = {
    originalMessage: message,
    error: {
      message: error.message,
      stack: error.stack,
      code: (error as any).code,
    },
    attempts: 1, // We don't have access to the retry count here
    lastAttemptAt: Math.floor(Date.now() / 1000),
  };

  await env.DEAD_LETTER_QUEUE.send(deadLetterMessage);

  logger().info(
    {
      messageType: message.type,
      errorMessage: error.message,
    },
    'Sent failed message to dead letter queue',
  );
}

// MessageBatch is now imported from the types.ts file

/**
 * Process a single item (file)
 * @param metadata Item metadata
 * @param ingestor Ingestor instance
 * @param contentService Content service
 */
async function processItem(
  metadata: ItemMetadata,
  ingestor: Ingestor,
  contentService: ContentService,
): Promise<void> {
  // Check if the item has changed
  const hasChanged = await ingestor.hasChanged(metadata);

  if (!hasChanged) {
    logger().info({ path: metadata.path, sha: metadata.sha }, 'Item has not changed, skipping');
    return;
  }

  // Fetch content
  const contentItem = await ingestor.fetchContent(metadata);

  // Get content as string or stream
  const content = await contentItem.getContent();

  // Store content in Silo
  await contentService.storeContent(content, {
    sha: metadata.sha,
    size: metadata.size,
    mimeType: metadata.mimeType,
  });

  // Add content reference
  // Ensure path is defined
  if (!metadata.path) {
    throw new Error(`Missing path in metadata for item ${metadata.id}`);
  }

  await contentService.addContentReference({
    id: metadata.id,
    repoId: metadata.repoId,
    path: metadata.path,
    sha: metadata.sha,
    size: metadata.size,
    mimeType: metadata.mimeType,
  });

  logger().info({ path: metadata.path, sha: metadata.sha }, 'Processed item successfully');
}

/**
 * Determine if an error is transient (should be retried)
 * @param error Error to check
 * @returns Whether the error is transient
 */
function isTransientError(error: Error): boolean {
  // Network errors, rate limits, and temporary server errors are transient
  const transientMessages = [
    'network error',
    'timeout',
    'rate limit',
    'too many requests',
    '429',
    '500',
    '502',
    '503',
    '504',
    'temporary',
    'retry',
  ];

  const message = error.message.toLowerCase();

  // Check if the error message contains any transient indicators
  return transientMessages.some(term => message.includes(term));
}
