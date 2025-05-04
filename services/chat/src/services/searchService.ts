import { getLogger } from '@dome/common';
import { Document, SourceMetadata } from '../types';
import {
  ConstellationBinding,
  ConstellationClient,
  createConstellationClient,
} from '@dome/constellation/client';
import { SiloClient } from '@dome/silo/client';
import { VectorMeta, ContentCategory, MimeType } from '@dome/common';

/**
 * Search options interface
 */
export interface SearchOptions {
  userId: string;
  query: string;
  limit?: number;
  offset?: number;
  category?: ContentCategory;
  mimeType?: MimeType;
  startDate?: number;
  endDate?: number;
  minRelevance?: number;
  expandSynonyms?: boolean;
  includeRelated?: boolean;
}

/**
 * Service for searching content
 */
export class SearchService {
  private readonly logger = getLogger();

  constructor(private constellation: ConstellationClient, private silo: SiloClient) { }

  static fromEnv(env: Env): SearchService {
    return new SearchService(
      env.CONSTELLATION as unknown as ConstellationClient,
      env.SILO as unknown as SiloClient,
    );
  }

  /**
   * Search for content using the Constellation service directly
   * @param env Environment bindings
   * @param options Search options
   * @returns Promise resolving to an array of documents
   */
  async search(options: SearchOptions): Promise<Document[]> {
    const {
      userId,
      query,
      limit = 10,
      minRelevance = 0.5,
      expandSynonyms = false,
      includeRelated = false,
    } = options;

    this.logger.info(
      {
        userId,
        query,
        limit,
        minRelevance,
        expandSynonyms,
        includeRelated,
      },
      'Searching for content using Constellation',
    );

    try {
      // Create filter for the query
      const filter: Partial<VectorMeta> = { userId };

      // Add category filter if specified
      if (options.category) {
        filter.category = options.category;
      }

      // Add mime type filter if specified
      if (options.mimeType) {
        filter.mimeType = options.mimeType;
      }

      // Perform the vector search
      const searchResults = await this.constellation.query(query, filter, limit);

      if (searchResults.length === 0) {
        this.logger.info({ userId, query }, 'No search results found');
        return [];
      }

      // Extract unique content IDs
      const contentIds = [...new Set(searchResults.map(result => result.metadata.contentId))];

      this.logger.info(
        {
          contentIdsCount: contentIds.length,
          firstFewContentIds: contentIds.slice(0, 5),
          userId,
        },
        'Unique content IDs extracted',
      );

      const contents = await this.silo.batchGet({ ids: contentIds, userId });
      this.logger.info(
        {
          contentsCount: contents.items.length,
          titles: contents.items.map(c => c.title),
          firstContentId: contents.items.length > 0 ? contents.items[0].id : null,
        },
        'Results from siloService.batchGet',
      );

      // Map content IDs to scores
      const scoreMap = new Map<string, number>();
      for (const result of searchResults) {
        // Extract the contentId from the result.id which is in format "content:contentId:chunkId"
        const contentId = result.metadata.contentId;
        // Store score by contentId
        if (!scoreMap.has(contentId) || result.score > scoreMap.get(contentId)!) {
          scoreMap.set(contentId, result.score);
        }
      }
      this.logger.info(
        {
          scoreMapSize: scoreMap.size,
          scores: Array.from(scoreMap.entries()).slice(0, 5),
          firstResult:
            searchResults.length > 0
              ? {
                id: searchResults[0].id,
                contentId: searchResults[0].metadata.contentId,
                score: searchResults[0].score,
              }
              : null,
        },
        'Created score map',
      );

      return contents.items
        .map(content => {
          const contentId = content.id;
          const score = scoreMap.get(contentId) || 0;

          return {
            id: contentId,
            title: content.title || `Unknown title`,
            body: content.body || '',
            metadata: {
              summary: content.summary,
              source: content.category || 'unknown',
              createdAt: new Date(content.createdAt || Date.now()).toISOString(),
              relevanceScore: score,
              url: content.url || null,
              mimeType: content.mimeType || 'text/plain',
            },
          };
        })
        .filter(doc => doc.metadata.relevanceScore >= minRelevance);
    } catch (error) {
      this.logger.error(
        {
          err: error,
          userId,
          query,
        },
        'Error searching for content',
      );

      // Return empty array on error
      return [];
    }
  }

  /**
   * Extract metadata from documents for source attribution
   * @param docs Array of documents
   * @returns Array of source metadata
   */
  static extractSourceMetadata(docs: Document[]): SourceMetadata[] {
    return docs.map(doc => ({
      id: doc.id,
      title: doc.title,
      source: doc.metadata.source,
      url: doc.metadata.url || null,
      relevanceScore: doc.metadata.relevanceScore,
    }));
  }

  /**
   * Rank documents by relevance and filter out low-quality matches
   * @param docs Array of documents
   * @param minRelevance Minimum relevance score (0-1)
   * @returns Filtered and ranked array of documents
   */
  static rankAndFilterDocuments(docs: Document[], minRelevance = 0.5): Document[] {
    // Filter out documents with low relevance scores
    const filteredDocs = docs.filter(doc => doc.metadata.relevanceScore >= minRelevance);

    // Sort by relevance score (highest first)
    return filteredDocs.sort((a, b) => b.metadata.relevanceScore - a.metadata.relevanceScore);
  }
}
