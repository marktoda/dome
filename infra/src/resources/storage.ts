import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../config';
import { getResourceTags, tagResource } from '../utils/tags';

/**
 * Create R2 Buckets for the Dome infrastructure
 * @returns Record of R2 Bucket resources
 */
export function createR2Buckets(): Record<string, cloudflare.R2Bucket> {
  const buckets: Record<string, cloudflare.R2Bucket> = {};

  try {
    // Dome Raw Bucket
    buckets.domeRaw = new cloudflare.R2Bucket('dome-raw', {
      name: resourceName('dome-raw'),
      location: 'wnam', // West North America
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags (for future use when Cloudflare supports tagging)
    tagResource(buckets.domeRaw, 'bucket', 'dome-raw', {
      Purpose: 'raw-file-storage',
      Service: 'multiple',
    });

    // Silo Content Bucket
    buckets.siloContent = new cloudflare.R2Bucket('silo-content', {
      name: resourceName('silo-content'),
      location: 'wnam', // West North America
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags (for future use when Cloudflare supports tagging)
    tagResource(buckets.siloContent, 'bucket', 'silo-content', {
      Purpose: 'content-storage',
      Service: 'silo',
    });

    // Add validation to ensure bucket names are valid
    for (const [key, bucket] of Object.entries(buckets)) {
      if (!bucket.name) {
        throw new Error(`Bucket ${key} has an invalid name`);
      }
    }
  } catch (error) {
    // Handle errors during bucket creation
    console.error('Error creating R2 buckets:', error);
    throw error;
  }

  return buckets;
}

/**
 * Export bucket names for reference in other modules
 * @param buckets The bucket resources
 * @returns Record of bucket names
 */
export function getBucketNames(
  buckets: Record<string, cloudflare.R2Bucket>,
): Record<string, pulumi.Output<string>> {
  const bucketNames: Record<string, pulumi.Output<string>> = {};

  for (const [key, bucket] of Object.entries(buckets)) {
    bucketNames[key] = bucket.name;
  }

  return bucketNames;
}
