import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../config';
import { getResourceTags, tagResource } from '../utils/tags';

/**
 * Create Workers Queues for the Dome infrastructure
 * @returns Record of Workers Queue resources
 */
export function createQueues(): Record<string, cloudflare.WorkersQueue> {
  const queues: Record<string, cloudflare.WorkersQueue> = {};

  try {
    // New Content Constellation Queue
    queues.newContentConstellation = new cloudflare.WorkersQueue('new-content-constellation', {
      name: resourceName('new-content-constellation'),
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags (for future use when Cloudflare supports tagging)
    tagResource(queues.newContentConstellation, 'queue', 'new-content-constellation', {
      Purpose: 'content-embedding',
      Producer: 'silo',
      Consumer: 'constellation',
    });

    // New Content AI Queue
    queues.newContentAi = new cloudflare.WorkersQueue('new-content-ai', {
      name: resourceName('new-content-ai'),
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags
    tagResource(queues.newContentAi, 'queue', 'new-content-ai', {
      Purpose: 'content-ai-processing',
      Producer: 'silo',
      Consumer: 'ai-processor',
    });

    // Content Events Queue
    queues.contentEvents = new cloudflare.WorkersQueue('silo-content-uploaded', {
      name: resourceName('silo-content-uploaded'),
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags
    tagResource(queues.contentEvents, 'queue', 'silo-content-uploaded', {
      Purpose: 'r2-object-events',
      Producer: 'r2',
      Consumer: 'silo',
    });

    // Enriched Content Queue
    queues.enrichedContent = new cloudflare.WorkersQueue('enriched-content', {
      name: resourceName('enriched-content'),
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags
    tagResource(queues.enrichedContent, 'queue', 'enriched-content', {
      Purpose: 'processed-content',
      Producer: 'ai-processor',
      Consumer: 'silo',
    });

    // Dome Events Queue
    queues.domeEvents = new cloudflare.WorkersQueue('dome-events', {
      name: resourceName('dome-events'),
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags
    tagResource(queues.domeEvents, 'queue', 'dome-events', {
      Purpose: 'system-events',
      Producer: 'multiple',
      Consumer: 'dome-notify,dome-cron',
    });

    // Embed Dead Letter Queue
    queues.embedDeadLetter = new cloudflare.WorkersQueue('embed-dead-letter', {
      name: resourceName('embed-dead-letter'),
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags
    tagResource(queues.embedDeadLetter, 'queue', 'embed-dead-letter', {
      Purpose: 'failed-embedding-jobs',
      Producer: 'constellation',
      Consumer: 'none',
    });

    // Add validation to ensure queue names are valid
    for (const [key, queue] of Object.entries(queues)) {
      if (!queue.name) {
        throw new Error(`Queue ${key} has an invalid name`);
      }
    }
  } catch (error) {
    // Handle errors during queue creation
    console.error('Error creating Workers Queues:', error);
    throw error;
  }

  return queues;
}

/**
 * Export queue names for reference in other modules
 * @param queues The queue resources
 * @returns Record of queue names
 */
export function getQueueNames(
  queues: Record<string, cloudflare.WorkersQueue>,
): Record<string, pulumi.Output<string>> {
  const queueNames: Record<string, pulumi.Output<string>> = {};

  for (const [key, queue] of Object.entries(queues)) {
    queueNames[key] = queue.name;
  }

  return queueNames;
}

