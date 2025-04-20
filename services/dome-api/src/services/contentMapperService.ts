import {
  ServiceError,
  SiloContent,
  ContentType,
  VectorSearchResult,
  SiloSimplePutResponse,
  SiloBatchGetItem,
} from '@dome/common';

// Legacy type definitions for backward compatibility
// These will be removed once all code is migrated to use SiloContent
interface Note {
  id: string;
  userId: string;
  title: string;
  body: string;
  contentType: string;
  createdAt: number;
  updatedAt?: number;
  metadata?: string;
}

interface CreateNoteData {
  userId: string;
  title: string;
  body: string;
  contentType: string;
  metadata?: string;
}

interface NotePage {
  noteId: string;
  pageNum: number;
  content: string;
}

enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

interface Task {
  id: string;
  userId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: number;
  createdAt: number;
  updatedAt?: number;
}

interface CreateTaskData {
  userId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: number;
}

/**
 * ContentMapperService
 *
 * This service is responsible for mapping between dome-api models and Silo/Constellation models.
 * It provides methods to convert between different data structures used by these services.
 */
export class ContentMapperService {
  /**
   * Map VectorSearchResults to Content IDs
   *
   * @param results - The vector search results to map
   * @returns An array of content IDs with their scores
   */
  /**
   * Map VectorSearchResults to Content IDs
   *
   * @param results - The vector search results to map
   * @returns An array of content IDs with their scores
   */
  mapVectorResultsToContentIds(
    results: VectorSearchResult[],
  ): Array<{ contentId: string; score: number }> {
    // Add detailed logging to understand the metadata structure
    if (results.length > 0) {
      const firstResult = results[0];
      console.log('First search result metadata:', JSON.stringify(firstResult.metadata));
      console.log('Has contentId:', 'contentId' in firstResult.metadata);
      console.log('Metadata keys:', Object.keys(firstResult.metadata));
    }
    
    return results.map(result => {
      // Check if metadata exists
      if (!result.metadata) {
        console.log('Missing metadata in search result:', result.id);
        return { contentId: '', score: result.score };
      }
      
      // Extract contentId with more robust checks
      let contentId = '';
      const metadata = result.metadata as any;
      
      if (metadata.hasOwnProperty('contentId') && metadata.contentId) {
        contentId = metadata.contentId;
      } else {
        // Try to extract contentId from the vector ID (format: content:contentId:chunkIndex)
        const idParts = result.id.split(':');
        if (idParts.length >= 2 && idParts[0] === 'content') {
          contentId = idParts[1];
        }
      }
      
      console.log(`Mapped result ${result.id} to contentId: ${contentId}`);
      
      return {
        contentId,
        score: result.score,
      };
    });
  }
  
  /**
   * Map VectorSearchResults to Note IDs (legacy method)
   *
   * @param results - The vector search results to map
   * @returns An array of note IDs with their scores
   * @deprecated Use mapVectorResultsToContentIds instead
   */
  mapVectorResultsToNoteIds(
    results: VectorSearchResult[],
  ): Array<{ noteId: string; score: number }> {
    // Call the new method and convert the result
    return this.mapVectorResultsToContentIds(results).map(result => ({
      noteId: result.contentId,
      score: result.score,
    }));
  }

  /**
   * Map a Silo BatchGetItem to a SiloContent object
   *
   * @param item - The Silo batch get item to map
   * @returns A SiloContent object
   */
  mapBatchGetItemToNote(item: SiloBatchGetItem): SiloContent {
    // Extract title from metadata if available
    let title = '';
    let metadata: Record<string, any> = {};

    try {
      // Attempt to parse metadata from the content if it exists
      if (item.body) {
        const firstLine = item.body.split('\n')[0].trim();
        if (firstLine) {
          title = firstLine;
        }
      }
    } catch (error) {
      // If parsing fails, use a default title
      title = `Content ${item.id}`;
    }

    return {
      id: item.id,
      userId: item.userId || null,
      title: title,
      body: item.body || '',
      contentType: item.contentType as ContentType,
      size: item.size,
      createdAt: item.createdAt * 1000, // Convert seconds to milliseconds
      updatedAt: item.createdAt * 1000, // Use same timestamp for updatedAt initially
      metadata: metadata,
    };
  }
}

/**
 * Singleton instance of the content mapper service
 */
export const contentMapperService = new ContentMapperService();
