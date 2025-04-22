import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../config';
import { getResourceTags, tagResource } from '../utils/tags';

/**
 * Create Vectorize Indexes for the Dome infrastructure
 * @returns Record of Vectorize Index resources
 */
export function createVectorizeIndexes(): Record<string, cloudflare.VectorizeIndex> {
  const indexes: Record<string, cloudflare.VectorizeIndex> = {};

  try {
    // Dome Notes Index
    indexes.domeNotes = new cloudflare.VectorizeIndex('dome-notes', {
      name: resourceName('dome-notes'),
      dimensions: 1536, // OpenAI embedding dimensions
      metric: 'cosine', // Cosine similarity
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags (for future use when Cloudflare supports tagging)
    tagResource(indexes.domeNotes, 'vectorize', 'dome-notes', {
      Purpose: 'vector-storage-notes',
      Service: 'constellation',
      ModelType: 'openai-compatible',
    });

    // Add validation to ensure index configuration is valid
    for (const [key, index] of Object.entries(indexes)) {
      if (!index.name) {
        throw new Error(`Vectorize index ${key} has an invalid name`);
      }

      if (!index.dimensions || index.dimensions <= 0) {
        throw new Error(`Vectorize index ${key} has invalid dimensions: ${index.dimensions}`);
      }
    }
  } catch (error) {
    // Handle errors during index creation
    console.error('Error creating Vectorize indexes:', error);
    throw error;
  }

  return indexes;
}

/**
 * Export index names for reference in other modules
 * @param indexes The vectorize index resources
 * @returns Record of index names
 */
export function getIndexNames(
  indexes: Record<string, cloudflare.VectorizeIndex>,
): Record<string, pulumi.Output<string>> {
  const indexNames: Record<string, pulumi.Output<string>> = {};

  for (const [key, index] of Object.entries(indexes)) {
    indexNames[key] = index.name;
  }

  return indexNames;
}
