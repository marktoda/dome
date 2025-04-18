import { Bindings } from '../types';
import { ServiceError } from '@dome/common';
import { Note, EmbeddingStatus } from '../models/note';
import { NoteRepository } from '../repositories/noteRepository';
import { r2Service } from './r2Service';
import { fileProcessingService, FileType, ProcessedFile } from './fileProcessingService';
import { noteIndexingService } from './noteIndexingService';

/**
 * Service for handling file attachments for notes
 */
export class FileAttachmentService {
  private noteRepository: NoteRepository;

  /**
   * Constructor
   */
  constructor() {
    this.noteRepository = new NoteRepository();
  }

  /**
   * Attach a file to a note
   * @param env Environment bindings
   * @param userId User ID
   * @param title Note title
   * @param data File data
   * @param contentType Content type
   * @param fileName Optional file name
   * @returns Promise with the created note
   */
  async attachFileToNote(
    env: Bindings,
    userId: string,
    title: string,
    data: ReadableStream | ArrayBuffer | string,
    contentType: string,
    fileName?: string,
  ): Promise<Note> {
    try {
      // Process the file
      const processedFile = await fileProcessingService.processFile(
        env,
        data,
        contentType,
        fileName,
      );

      // Create metadata JSON
      const metadataJson = JSON.stringify({
        fileName,
        fileType: processedFile.metadata.fileType,
        size: processedFile.metadata.size,
        pages: processedFile.metadata.pages,
        additionalMetadata: processedFile.metadata.additionalMetadata,
      });

      // Determine the body content based on file type
      let body = '';

      if (processedFile.metadata.extractedText) {
        // Use extracted text for the body
        body = processedFile.metadata.extractedText;
      } else {
        // Use a placeholder for files that need further processing
        body = `[File: ${fileName || processedFile.r2Key}]`;
      }

      // Create the note
      const note = await this.noteRepository.create(env, {
        userId,
        title,
        body,
        contentType,
        r2Key: processedFile.r2Key,
        metadata: metadataJson,
      });

      // If we have text content, index it immediately
      if (processedFile.chunks && processedFile.chunks.length > 0) {
        await noteIndexingService.indexNote(env, note);
      }

      return note;
    } catch (error) {
      console.error('Error attaching file to note:', error);
      throw new ServiceError('Failed to attach file to note', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { userId, title, contentType, fileName },
      });
    }
  }

  /**
   * Process and update a note with file content
   * @param env Environment bindings
   * @param noteId Note ID
   * @returns Promise with the updated note
   */
  async processFileContent(env: Bindings, noteId: string): Promise<Note> {
    try {
      // Get the note
      const note = await this.noteRepository.findById(env, noteId);

      if (!note) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      // Check if note has an R2 key
      if (!note.r2Key) {
        throw new Error(`Note with ID ${noteId} does not have an attached file`);
      }

      // Parse metadata
      const metadata = note.metadata ? JSON.parse(note.metadata) : {};
      const fileType = metadata.fileType;

      // Extract text based on file type
      let extractedText = '';

      if (fileType === FileType.PDF) {
        extractedText = await fileProcessingService.extractTextFromPdf(env, note.r2Key);
      } else if (fileType === FileType.IMAGE) {
        extractedText = await fileProcessingService.extractTextFromImage(env, note.r2Key);
      } else {
        // For other file types, download and process
        const object = await r2Service.downloadObject(env, note.r2Key);

        if (!object) {
          throw new Error(`File with key ${note.r2Key} not found`);
        }

        // Convert ReadableStream to text
        const reader = object.data.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        const allChunks = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
        let position = 0;

        for (const chunk of chunks) {
          allChunks.set(chunk, position);
          position += chunk.length;
        }

        extractedText = new TextDecoder().decode(allChunks);
      }

      // Update metadata with extracted text
      metadata.extractedText = 'Processed';

      // Update the note with extracted text
      const updatedNote = await this.noteRepository.update(env, noteId, {
        body: extractedText,
        metadata: JSON.stringify(metadata),
        embeddingStatus: EmbeddingStatus.PENDING,
      });

      // Trigger indexing
      await noteIndexingService.indexNote(env, updatedNote);

      return updatedNote;
    } catch (error) {
      console.error(`Error processing file content for note ${noteId}:`, error);
      throw new ServiceError(`Failed to process file content for note ${noteId}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId },
      });
    }
  }

  /**
   * Delete a file attachment
   * @param env Environment bindings
   * @param noteId Note ID
   * @returns Promise<boolean> True if deleted, false if not found
   */
  async deleteFileAttachment(env: Bindings, noteId: string): Promise<boolean> {
    try {
      // Get the note
      const note = await this.noteRepository.findById(env, noteId);

      if (!note) {
        return false;
      }

      // Check if note has an R2 key
      if (!note.r2Key) {
        return false;
      }

      // Delete the file from R2
      await r2Service.deleteObject(env, note.r2Key);

      // Update the note to remove the R2 key
      await this.noteRepository.update(env, noteId, {
        r2Key: undefined,
        metadata: undefined,
      });

      return true;
    } catch (error) {
      console.error(`Error deleting file attachment for note ${noteId}:`, error);
      throw new ServiceError(`Failed to delete file attachment for note ${noteId}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId },
      });
    }
  }

  /**
   * Get a file attachment
   * @param env Environment bindings
   * @param noteId Note ID
   * @returns Promise with the file data and metadata
   */
  async getFileAttachment(
    env: Bindings,
    noteId: string,
  ): Promise<{ data: ReadableStream; contentType: string } | null> {
    try {
      // Get the note
      const note = await this.noteRepository.findById(env, noteId);

      if (!note || !note.r2Key) {
        return null;
      }

      // Get the file from R2
      const object = await r2Service.downloadObject(env, note.r2Key);

      if (!object) {
        return null;
      }

      return {
        data: object.data,
        contentType: object.metadata.contentType,
      };
    } catch (error) {
      console.error(`Error getting file attachment for note ${noteId}:`, error);
      throw new ServiceError(`Failed to get file attachment for note ${noteId}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { noteId },
      });
    }
  }
}

// Export singleton instance
export const fileAttachmentService = new FileAttachmentService();
