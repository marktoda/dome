/**
 * Batch Re-Embedding Script for Silo Data
 *
 * This script triggers re-embedding and re-AI processing of all content in Silo.
 * It queries all content from the D1 database, then sends messages to the NEW_CONTENT queues
 * to trigger re-embedding by Constellation and AI services.
 *
 * Usage:
 *   cd /home/toda/dev/dome
 *   npx tsx scripts/batch-reembed-silo-data.ts [--batchSize=100] [--dryRun] [--help]
 *
 * Options:
 *   --batchSize=<number>  Number of items to process in each batch (default: 100)
 *   --dryRun              Run without actually sending messages to queues
 *   --help                Show this help message
 */

import { NewContentMessage, NewContentMessageSchema, serializeQueueMessage } from '@dome/common';
import { getLogger, logError } from '@dome/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Initialize logger
const logger = getLogger();

// Helper for executing commands
const execAsync = promisify(exec);

// Command line arguments
interface CommandLineArgs {
  batchSize: number;
  dryRun: boolean;
  help: boolean;
}

// Parse command line arguments manually
function parseArgs(): CommandLineArgs {
  const args: CommandLineArgs = {
    batchSize: 100,
    dryRun: false,
    help: false,
  };

  process.argv.slice(2).forEach(arg => {
    if (arg.startsWith('--batchSize=')) {
      args.batchSize = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--dryRun' || arg === '-d') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  });

  return args;
}

const args = parseArgs();

// Show help if requested
if (args.help) {
  console.log(`
  Batch Re-Embedding Script for Silo Data

  This script triggers re-embedding and re-AI processing of all content in Silo.

  Usage:
    cd /home/toda/dev/dome
    npx tsx scripts/batch-reembed-silo-data.ts [--batchSize=100] [--dryRun] [--help]

  Options:
    --batchSize=<number>  Number of items to process in each batch (default: 100)
    --dryRun              Run without actually sending messages to queues
    --help                Show this help message
  `);
  process.exit(0);
}

/**
 * Creates a temporary file with the given content and returns its path
 */
async function createTempFile(prefix: string, content: string): Promise<string> {
  // Generate a unique temporary file path
  const tempFilePath = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
  );

  try {
    // Write content to the temporary file
    await fs.writeFile(tempFilePath, content);
    return tempFilePath;
  } catch (error) {
    logError(error, `Failed to create temporary file`, { path: tempFilePath });
    throw error;
  }
}

/**
 * Safely deletes a file if it exists
 */
async function safelyDeleteFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    // Only log but don't throw if the error is that the file doesn't exist
    if (typeof error === 'object' && error !== null && 'code' in error && error.code !== 'ENOENT') {
      logger.warn({ error, path: filePath }, `Failed to delete temporary file`);
    }
  }
}

async function main() {
  logger.info(`Starting batch re-embedding process${args.dryRun ? ' (DRY RUN)' : ''}`);
  logger.info(`Batch size: ${args.batchSize}`);
  logger.info(`Using temporary directory: ${os.tmpdir()}`);

  const contents = await fs.readFile('./scripts/contents.json', 'utf-8');
  // Parse the results
  const results = JSON.parse(contents);
  const contentItems = results[0].results || [];

  if (!contentItems || contentItems.length === 0) {
    logger.warn('No content found in Silo database.');
    return;
  }

  logger.info(`Found ${contentItems.length} content items to process`);

  // Process in batches
  const totalBatches = Math.ceil(contentItems.length / args.batchSize);
  let processedCount = 0;
  let successCount = 0;
  let failureCount = 0;

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * args.batchSize;
    const end = Math.min(start + args.batchSize, contentItems.length);
    const batch = contentItems.slice(start, end);

    logger.info(`Processing batch ${batchIndex + 1}/${totalBatches} (items ${start + 1}-${end})`);

    for (const item of batch) {
      try {
        const message: NewContentMessage = {
          id: item.id,
          userId: item.userId,
          category: item.contentType || 'note',
        };

        if (!args.dryRun) {
          // Use wrangler CLI to send messages to queues
          logger.info(`Sending message for content ID: ${item.id}`);

          // Create temporary message file
          let tempMessageFile: string | null = null;

          try {
            // Create temporary message file with validated payload
            const messageJson = serializeQueueMessage(
              NewContentMessageSchema,
              message,
            );
            tempMessageFile = await createTempFile('silo-message', messageJson);
            logger.debug(`Created temporary message file at ${tempMessageFile}`);

            // Send to both queues
            try {
              await execAsync(
                `wrangler queues publish new-content-constellation ${tempMessageFile}`,
              );
              logger.debug(`Sent message to constellation queue for ID: ${item.id}`);
            } catch (queueError) {
              logError(queueError, `Failed to send to constellation queue for ID: ${item.id}`);
            }

            try {
              await execAsync(`wrangler queues publish new-content-ai ${tempMessageFile}`);
              logger.debug(`Sent message to AI queue for ID: ${item.id}`);
            } catch (queueError) {
              logError(queueError, `Failed to send to AI queue for ID: ${item.id}`);
            }
          } finally {
            // Clean up
            if (tempMessageFile) {
              await safelyDeleteFile(tempMessageFile);
            }
          }
        }

        logger.debug(`Sent message for content ID: ${item.id}`);
        successCount++;
      } catch (error) {
        logError(error, `Failed to send message for content ID: ${item.id}`, {
          contentId: item.id,
        });
        failureCount++;
      }

      processedCount++;

      // Log progress every 10% of total
      if (processedCount % Math.max(1, Math.floor(contentItems.length / 10)) === 0) {
        const percentComplete = ((processedCount / contentItems.length) * 100).toFixed(1);
        logger.info(`Progress: ${percentComplete}% (${processedCount}/${contentItems.length})`);
      }
    }

    logger.info(`Completed batch ${batchIndex + 1}/${totalBatches}`);

    // Small delay between batches to avoid overwhelming the system
    if (batchIndex < totalBatches - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Log final summary
  logger.info('===== Batch Re-Embedding Summary =====');
  logger.info(`Total content items: ${contentItems.length}`);
  logger.info(`Successfully processed: ${successCount}`);
  logger.info(`Failed to process: ${failureCount}`);
  logger.info(
    `${args.dryRun ? '[DRY RUN] No actual messages were sent' : 'All messages sent successfully'}`,
  );
  logger.info('======================================');
}

// Execute main function
main().catch(error => {
  logError(error, 'Unhandled error in batch re-embedding script');
  process.exit(1);
});
