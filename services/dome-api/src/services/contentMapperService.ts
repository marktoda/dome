import { ServiceError } from '@dome/common';
import { Note, CreateNoteData, UpdateNoteData, NotePage } from '../models/note';
import { Task, CreateTaskData, UpdateTaskData, TaskStatus, TaskPriority } from '../models/task';
import {
  SiloContentMetadata,
  SiloSimplePutRequest,
  SiloSimplePutResponse,
  SiloBatchGetItem,
} from '../types/siloTypes';
import {
  ConstellationEmbedJob,
  ConstellationVectorMeta,
  ConstellationVectorSearchResult,
} from '../types/constellationTypes';

/**
 * ContentMapperService
 *
 * This service is responsible for mapping between dome-api models and Silo/Constellation models.
 * It provides methods to convert between different data structures used by these services.
 */
export class ContentMapperService {
  /**
   * Map a dome-api Note to a Silo SimplePutRequest
   *
   * @param note - The note to map
   * @returns A Silo SimplePutRequest object
   */
  mapNoteToPutRequest(note: Note | CreateNoteData): SiloSimplePutRequest {
    return {
      id: 'id' in note ? note.id : undefined,
      userId: note.userId,
      content: note.body,
      contentType: note.contentType,
      metadata: {
        title: note.title,
        ...(note.metadata ? JSON.parse(note.metadata) : {}),
      },
    };
  }

  /**
   * Map a Silo SimplePutResponse to a partial dome-api Note
   *
   * @param response - The Silo response to map
   * @returns A partial Note object
   */
  mapPutResponseToNote(response: SiloSimplePutResponse): Partial<Note> {
    return {
      id: response.id,
      contentType: response.contentType,
      createdAt: response.createdAt * 1000, // Convert seconds to milliseconds
      updatedAt: response.createdAt * 1000, // Use same timestamp for updatedAt initially
    };
  }

  /**
   * Map a dome-api Note to a Constellation EmbedJob
   *
   * @param note - The note to map
   * @param text - Optional text override (if different from note.body)
   * @returns A Constellation EmbedJob object
   */
  mapNoteToEmbedJob(note: Note, text?: string): ConstellationEmbedJob {
    return {
      userId: note.userId,
      noteId: note.id,
      text: text || note.body,
      created: Date.now(),
      version: 1,
    };
  }

  /**
   * Map a dome-api NotePage to a Constellation EmbedJob
   *
   * @param notePage - The note page to map
   * @param userId - The user ID associated with the note page
   * @returns A Constellation EmbedJob object
   */
  mapNotePageToEmbedJob(notePage: NotePage, userId: string): ConstellationEmbedJob {
    return {
      userId: userId,
      noteId: `${notePage.noteId}_page_${notePage.pageNum}`,
      text: notePage.content,
      created: Date.now(),
      version: 1,
    };
  }

  /**
   * Map Constellation VectorSearchResults to Note IDs
   *
   * @param results - The vector search results to map
   * @returns An array of note IDs with their scores
   */
  mapVectorResultsToNoteIds(
    results: ConstellationVectorSearchResult[],
  ): Array<{ noteId: string; score: number }> {
    return results.map(result => ({
      noteId: result.metadata.noteId,
      score: result.score,
    }));
  }

  /**
   * Map a Silo BatchGetItem to a partial dome-api Note
   *
   * @param item - The Silo batch get item to map
   * @returns A partial Note object
   */
  mapBatchGetItemToNote(item: SiloBatchGetItem): Partial<Note> {
    // Extract title from metadata if available
    let title = '';
    let metadata = '';

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
      userId: item.userId || '',
      title: title,
      body: item.body || '',
      contentType: item.contentType,
      createdAt: item.createdAt * 1000, // Convert seconds to milliseconds
      updatedAt: item.createdAt * 1000, // Use same timestamp for updatedAt initially
      metadata: metadata,
    };
  }

  /**
   * Map a dome-api Task to a Silo SimplePutRequest
   *
   * @param task - The task to map
   * @returns A Silo SimplePutRequest object
   */
  mapTaskToPutRequest(task: Task | CreateTaskData): SiloSimplePutRequest {
    return {
      id: 'id' in task ? task.id : undefined,
      userId: task.userId,
      content: JSON.stringify({
        title: task.title,
        description: task.description || '',
        status: task.status,
        priority: task.priority,
        dueDate: task.dueDate,
      }),
      contentType: 'application/json',
      metadata: {
        type: 'task',
        status: task.status,
        priority: task.priority,
        dueDate: task.dueDate,
      },
    };
  }

  /**
   * Map a Silo BatchGetItem to a dome-api Task
   *
   * @param item - The Silo batch get item to map
   * @returns A partial Task object
   */
  mapBatchGetItemToTask(item: SiloBatchGetItem): Partial<Task> {
    let taskData: {
      title: string;
      description?: string;
      status: TaskStatus;
      priority: TaskPriority;
      dueDate?: number;
    } = {
      title: '',
      status: TaskStatus.PENDING,
      priority: TaskPriority.MEDIUM,
    };

    try {
      // Parse the task data from the content
      if (item.body) {
        taskData = JSON.parse(item.body);
      }
    } catch (error) {
      throw new ServiceError('Failed to parse task data', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { itemId: item.id },
      });
    }

    return {
      id: item.id,
      userId: item.userId || '',
      title: taskData.title,
      description: taskData.description,
      status: taskData.status,
      priority: taskData.priority,
      dueDate: taskData.dueDate,
      createdAt: item.createdAt * 1000, // Convert seconds to milliseconds
      updatedAt: item.createdAt * 1000, // Use same timestamp for updatedAt initially
    };
  }
}

/**
 * Singleton instance of the content mapper service
 */
export const contentMapperService = new ContentMapperService();
