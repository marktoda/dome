import { VectorMeta } from '@dome/common';

/**
 * Convert our strongly typed {@link VectorMeta} into the shape
 * expected by Cloudflare's {@link VectorizeVector} metadata.
 */
export function toIndexMetadata(meta: VectorMeta): VectorizeVector['metadata'] {
  return { ...meta } as Record<string, VectorizeVectorMetadata>;
}
