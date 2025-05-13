import { getLogger } from '@dome/common';
import { AgentState, Document, SourceMetadata } from '../types';

/**
 * Document-to-Sources Mapping Node
 *
 * Maps document objects to source metadata objects for streaming purposes.
 * This node creates a clean sources array from the docs array, which can be
 * sent as a streamed update to the client before answer generation.
 *
 * @param state Current agent state
 * @returns Updated agent state with sources derived from docs
 */
export async function docToSources(state: AgentState): Promise<Partial<AgentState>> {
  const t0 = performance.now();
  const logger = getLogger().child({ component: 'docToSources' });

  logger.info(
    {
      docsCount: state.docs?.length || 0,
    },
    'Mapping documents to sources for streaming',
  );

  // Skip if no docs are available
  if (!state.docs || state.docs.length === 0) {
    logger.info('No documents to map to sources');
    return {
      sources: [],
      metadata: {
        currentNode: 'doc_to_sources',
        nodeTimings: {
          docToSources: performance.now() - t0,
        },
      },
    };
  }

  // Map docs to sources metadata
  const sources: SourceMetadata[] = state.docs.map((doc: Document) => ({
    id: doc.id,
    title: doc.title || '',
    source: doc.metadata.source,
    url: doc.metadata.url || undefined,
    relevanceScore: doc.metadata.relevanceScore || 0,
    type: doc.metadata.sourceType || 'document', // Add type field for CLI compatibility
  }));

  const elapsed = performance.now() - t0;

  logger.info(
    {
      docsCount: state.docs.length,
      sourcesCount: sources.length,
      elapsedMs: elapsed,
    },
    'Successfully mapped documents to sources',
  );

  // Return the updated state with sources
  return {
    sources,
    metadata: {
      currentNode: 'doc_to_sources',
      nodeTimings: {
        docToSources: elapsed,
      },
    },
  };
}
