import { ulid } from 'ulid';
import { Env, IngestMessage, DeadLetterMessage } from '../types';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import { GitHubIngestor } from '../ingestors/github/github-ingestor';
import { ContentService } from '../services/content-service';
import { RepositoryService } from '../services/repository-service';
import { Ingestor, ItemMetadata } from '../ingestors/base';
import { getMimeType } from '../github/content-utils';

/**
 * Service for managing queue operations
 */
export class QueueService {
  private env: Env;

  /**
   * Create a new queue service
   * @param env Environment
   */
  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Validate an ingest message
   * @param message Message to validate
   * @returns Whether the message is valid
   */
  validateMessage(message: IngestMessage): boolean {
    // Check required fields
    if (!message.repoId || !message.provider || !message.owner || !message.repo) {
      logger.warn({ message }, 'Invalid message: missing required fields');
      return false;
    }

    // Check provider
    if (message.provider !== 'github') {
      logger.warn({ provider: message.provider }, 'Unsupported provider');
      return false;
    }

    // Check message type
    if (message.type !== 'repository' && message.type !== 'file') {
      logger.warn({ type: message.type }, 'Invalid message type');
      return false;
    }

    // For file messages, check path and sha
    if (message.type === 'file' && (!message.path || !message.sha)) {
      logger.warn({ message }, 'Invalid file message: missing path or sha');
      return false;
    }

    return true;
  }

  /**
   * Create an ingestor for a message
   * @param message Ingest message
   * @returns Ingestor instance
   */
  async createIngestor(message: IngestMessage): Promise<Ingestor> {
    const { repoId, userId, provider, owner, repo, branch, isPrivate, includePatterns, excludePatterns } = message;

    switch (provider) {
      case 'github':
        return GitHubIngestor.forRepository(
          repoId,
          userId,
          owner,
          repo,
          branch || 'main',
          isPrivate,
          includePatterns,
          excludePatterns,
          this.env
        );
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  /**
   * Enqueue a repository for ingestion
   * @param repoId Repository ID
   * @param userId User ID
   * @param provider Provider (e.g., 'github')
   * @param owner Repository owner
   * @param repo Repository name
   * @param branch Repository branch
   * @param isPrivate Whether the repository is private
   * @param includePatterns Include patterns
   * @param excludePatterns Exclude patterns
   * @returns Message ID
   */
  async enqueueRepository(
    repoId: string,
    userId: string | null,
    provider: string,
    owner: string,
    repo: string,
    branch: string = 'main',
    isPrivate: boolean = false,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): Promise<string> {
    const message: IngestMessage = {
      type: 'repository',
      repoId,
      userId,
      provider,
      owner,
      repo,
      branch,
      isPrivate,
      includePatterns,
      excludePatterns
    };

    // Generate a message ID if the queue doesn't return one
    const messageId = ulid();
    
    // Send the message to the queue
    await this.env.INGEST_QUEUE.send(message);
    
    logger.info(
      { repoId, owner, repo, messageId },
      'Enqueued repository for ingestion'
    );
    
    metrics.counter('queue_service.repository_enqueued', 1, {
      provider
    });
    
    return messageId;
  }

  /**
   * Enqueue a file for ingestion
   * @param repoId Repository ID
   * @param userId User ID
   * @param provider Provider (e.g., 'github')
   * @param owner Repository owner
   * @param repo Repository name
   * @param path File path
   * @param sha File SHA
   * @param branch Repository branch
   * @param isPrivate Whether the repository is private
   * @param includePatterns Include patterns
   * @param excludePatterns Exclude patterns
   * @returns Message ID
   */
  async enqueueFile(
    repoId: string,
    userId: string | null,
    provider: string,
    owner: string,
    repo: string,
    path: string,
    sha: string,
    branch: string = 'main',
    isPrivate: boolean = false,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): Promise<string> {
    const message: IngestMessage = {
      type: 'file',
      repoId,
      userId,
      provider,
      owner,
      repo,
      branch,
      path,
      sha,
      isPrivate,
      includePatterns,
      excludePatterns
    };

    // Generate a message ID if the queue doesn't return one
    const messageId = ulid();
    
    // Send the message to the queue
    await this.env.INGEST_QUEUE.send(message);
    
    logger.info(
      { repoId, owner, repo, path, messageId },
      'Enqueued file for ingestion'
    );
    
    metrics.counter('queue_service.file_enqueued', 1, {
      provider
    });
    
    return messageId;
  }

  /**
   * Enqueue files for ingestion
   * @param repoId Repository ID
   * @param userId User ID
   * @param provider Provider (e.g., 'github')
   * @param owner Repository owner
   * @param repo Repository name
   * @param files Array of file paths and SHAs
   * @param branch Repository branch
   * @param isPrivate Whether the repository is private
   * @param includePatterns Include patterns
   * @param excludePatterns Exclude patterns
   * @returns Array of message IDs
   */
  async enqueueFiles(
    repoId: string,
    userId: string | null,
    provider: string,
    owner: string,
    repo: string,
    files: Array<{ path: string; sha: string }>,
    branch: string = 'main',
    isPrivate: boolean = false,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): Promise<string[]> {
    const messageIds: string[] = [];
    
    // Enqueue files in batches to avoid hitting queue limits
    const batchSize = 100;
    
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      const batchPromises = batch.map(file => 
        this.enqueueFile(
          repoId,
          userId,
          provider,
          owner,
          repo,
          file.path,
          file.sha,
          branch,
          isPrivate,
          includePatterns,
          excludePatterns
        )
      );
      
      const batchIds = await Promise.all(batchPromises);
      messageIds.push(...batchIds);
      
      // Yield to avoid CPU time limit if there are more files
      if (i + batchSize < files.length) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    }
    
    logger.info(
      { repoId, owner, repo, fileCount: files.length },
      'Enqueued files for ingestion'
    );
    
    metrics.counter('queue_service.files_enqueued', files.length, {
      provider
    });
    
    return messageIds;
  }

  /**
   * Send a message to the dead letter queue
   * @param message Original message
   * @param error Error that occurred
   * @param attempts Number of attempts
   * @returns Message ID
   */
  async sendToDeadLetterQueue(
    message: IngestMessage,
    error: Error,
    attempts: number = 1
  ): Promise<string> {
    const deadLetterMessage: DeadLetterMessage = {
      originalMessage: message,
      error: {
        message: error.message,
        stack: error.stack,
        code: (error as any).code
      },
      attempts,
      lastAttemptAt: Math.floor(Date.now() / 1000)
    };

    // Generate a message ID if the queue doesn't return one
    const messageId = ulid();
    
    // Send the message to the queue
    await this.env.DEAD_LETTER_QUEUE.send(deadLetterMessage);
    
    logger.info(
      {
        messageType: message.type,
        repoId: message.repoId,
        errorMessage: error.message,
        attempts,
        messageId
      },
      'Sent message to dead letter queue'
    );
    
    metrics.counter('queue_service.dead_letter', 1, {
      message_type: message.type,
      error_type: error.name
    });
    
    return messageId;
  }

  /**
   * Process a file using the appropriate ingestor
   * @param metadata File metadata
   * @param ingestor Ingestor to use
   * @returns Whether the file was processed successfully
   */
  async processFile(metadata: ItemMetadata, ingestor: Ingestor): Promise<boolean> {
    const timer = metrics.startTimer('queue_service.process_file');
    
    try {
      // Check if the file has changed
      const hasChanged = await ingestor.hasChanged(metadata);
      
      if (!hasChanged) {
        logger.info(
          { path: metadata.path, sha: metadata.sha },
          'File has not changed, skipping'
        );
        timer.stop({ changed: 'false' });
        return true;
      }
      
      // Fetch content
      const contentItem = await ingestor.fetchContent(metadata);
      
      // Get content as string or stream
      const content = await contentItem.getContent();
      
      // Store content in Silo
      const contentService = new ContentService(this.env);
      await contentService.storeContent(content, {
        sha: metadata.sha,
        size: metadata.size,
        mimeType: metadata.mimeType
      });
      
      // Add content reference
      await contentService.addContentReference({
        id: metadata.id,
        repoId: metadata.repoId,
        path: metadata.path,
        sha: metadata.sha,
        size: metadata.size,
        mimeType: metadata.mimeType
      });
      
      // Update sync status
      await ingestor.updateSyncStatus(metadata);
      
      logger.info(
        { path: metadata.path, sha: metadata.sha },
        'Processed file successfully'
      );
      
      timer.stop({ success: 'true' });
      return true;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to process file ${metadata.path}`);
      throw error;
    }
  }

  /**
   * Process a repository using the appropriate ingestor
   * @param repoId Repository ID
   * @param ingestor Ingestor to use
   * @returns Number of files processed
   */
  async processRepository(repoId: string, ingestor: Ingestor): Promise<number> {
    const timer = metrics.startTimer('queue_service.process_repository');
    
    try {
      // List all items that need to be ingested
      const items = await ingestor.listItems();
      
      if (items.length === 0) {
        logger.info(
          { repoId },
          'No changes detected in repository'
        );
        timer.stop({ items: '0' });
        return 0;
      }
      
      // Process items in batches with concurrency limit
      const batchSize = 5; // Process 5 items at a time
      let processedCount = 0;
      
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        
        // Process batch in parallel
        const results = await Promise.allSettled(
          batch.map(item => this.processFile(item, ingestor))
        );
        
        // Count successful items
        processedCount += results.filter(r => r.status === 'fulfilled' && r.value).length;
        
        // Log errors for failed items
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            logError(result.reason, `Failed to process item ${batch[index].path}`, {
              repoId,
              path: batch[index].path
            });
          }
        });
        
        // Yield to avoid CPU time limit if there are more items
        if (i + batchSize < items.length) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
      
      // Update repository sync status with the last item's metadata
      if (items.length > 0 && processedCount > 0) {
        const lastItem = items[items.length - 1];
        await ingestor.updateSyncStatus(lastItem);
      }
      
      logger.info(
        { repoId, itemCount: items.length, processedCount },
        'Processed repository items'
      );
      
      timer.stop({ 
        items: items.length.toString(),
        processed: processedCount.toString()
      });
      
      return processedCount;
    } catch (error) {
      timer.stop({ error: 'true' });
      logError(error as Error, `Failed to process repository ${repoId}`);
      throw error;
    }
  }
}