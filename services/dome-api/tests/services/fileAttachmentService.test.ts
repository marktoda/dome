// Jest is automatically available in the global scope
import { fileAttachmentService } from '../../src/services/fileAttachmentService';
import { r2Service } from '../../src/services/r2Service';
import {
  fileProcessingService,
  FileType,
  ProcessedFile,
} from '../../src/services/fileProcessingService';
import { noteIndexingService } from '../../src/services/noteIndexingService';
import { NoteRepository } from '../../src/repositories/noteRepository';
import { EmbeddingStatus } from '../../src/models/note';
import { ServiceError } from '@dome/common';

// Mock dependencies
jest.mock('../../src/services/r2Service');
jest.mock('../../src/services/fileProcessingService');
jest.mock('../../src/services/noteIndexingService');
jest.mock('../../src/repositories/noteRepository');

describe('FileAttachmentService', () => {
  // Mock environment
  const mockEnv = {
    RAW: {} as R2Bucket,
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    EVENTS: {} as Queue<any>,
  };

  // Mock data
  const mockUserId = 'user-123';
  const mockTitle = 'Test File';
  const mockNoteId = 'note-123';
  const mockR2Key = 'files/1617235678000-abcdef.txt';

  // Mock note
  const mockNote = {
    id: mockNoteId,
    userId: mockUserId,
    title: mockTitle,
    body: 'This is a test file content',
    contentType: 'text/plain',
    r2Key: mockR2Key,
    metadata: JSON.stringify({
      fileName: 'test.txt',
      fileType: FileType.TEXT,
      size: 100,
    }),
    createdAt: 1617235678000,
    updatedAt: 1617235678000,
    embeddingStatus: EmbeddingStatus.PENDING,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock NoteRepository
    (NoteRepository as jest.Mock).mockImplementation(() => {
      return {
        create: jest.fn().mockResolvedValue(mockNote),
        findById: jest.fn().mockResolvedValue(mockNote),
        update: jest.fn().mockResolvedValue(mockNote),
      };
    });

    // Mock fileProcessingService.processFile
    (fileProcessingService.processFile as jest.Mock).mockResolvedValue({
      r2Key: mockR2Key,
      metadata: {
        contentType: 'text/plain',
        fileType: FileType.TEXT,
        size: 100,
        extractedText: 'This is a test file content',
      },
      chunks: ['This is a test file content'],
    } as ProcessedFile);

    // Mock fileProcessingService.extractTextFromPdf
    (fileProcessingService.extractTextFromPdf as jest.Mock).mockResolvedValue(
      'Extracted PDF text content',
    );

    // Mock fileProcessingService.extractTextFromImage
    (fileProcessingService.extractTextFromImage as jest.Mock).mockResolvedValue(
      'Extracted image text content',
    );

    // Mock r2Service.downloadObject
    (r2Service.downloadObject as jest.Mock).mockResolvedValue({
      data: new ReadableStream(),
      metadata: {
        contentType: 'text/plain',
        size: 100,
        etag: 'test-etag',
        uploaded: new Date(),
      },
    });

    // Mock r2Service.deleteObject
    (r2Service.deleteObject as jest.Mock).mockResolvedValue(true);

    // Mock noteIndexingService.indexNote
    (noteIndexingService.indexNote as jest.Mock).mockResolvedValue(undefined);
  });

  describe('attachFileToNote', () => {
    it('should attach a text file to a note', async () => {
      // Call the service
      const result = await fileAttachmentService.attachFileToNote(
        mockEnv,
        mockUserId,
        mockTitle,
        'This is a test file content',
        'text/plain',
        'test.txt',
      );

      // Verify the result
      expect(result).toEqual(mockNote);

      // Verify fileProcessingService was called
      expect(fileProcessingService.processFile).toHaveBeenCalledWith(
        mockEnv,
        'This is a test file content',
        'text/plain',
        'test.txt',
      );

      // Verify NoteRepository was called
      const noteRepo = fileAttachmentService['noteRepository'];
      expect(noteRepo.create).toHaveBeenCalledWith(mockEnv, {
        userId: mockUserId,
        title: mockTitle,
        body: 'This is a test file content',
        contentType: 'text/plain',
        r2Key: mockR2Key,
        metadata: expect.any(String),
      });

      // Verify noteIndexingService was called
      expect(noteIndexingService.indexNote).toHaveBeenCalledWith(mockEnv, mockNote);
    });

    it('should throw ServiceError when file processing fails', async () => {
      // Mock fileProcessingService.processFile to fail
      (fileProcessingService.processFile as jest.Mock).mockRejectedValue(
        new Error('Processing failed'),
      );

      // Call the service and expect it to throw
      await expect(
        fileAttachmentService.attachFileToNote(
          mockEnv,
          mockUserId,
          mockTitle,
          'This is a test file content',
          'text/plain',
          'test.txt',
        ),
      ).rejects.toThrow(ServiceError);
    });
  });

  describe('processFileContent', () => {
    it('should process PDF file content', async () => {
      // Mock note with PDF file
      const pdfNote = {
        ...mockNote,
        contentType: 'application/pdf',
        metadata: JSON.stringify({
          fileName: 'test.pdf',
          fileType: FileType.PDF,
          size: 1000,
        }),
      };

      // Mock findById to return PDF note
      fileAttachmentService['noteRepository'].findById = jest.fn().mockResolvedValue(pdfNote);

      // Call the service
      const result = await fileAttachmentService.processFileContent(mockEnv, mockNoteId);

      // Verify the result
      expect(result).toEqual(mockNote);

      // Verify fileProcessingService was called
      expect(fileProcessingService.extractTextFromPdf).toHaveBeenCalledWith(mockEnv, mockR2Key);

      // Verify NoteRepository was called
      const noteRepo = fileAttachmentService['noteRepository'];
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNoteId, {
        body: 'Extracted PDF text content',
        metadata: expect.any(String),
        embeddingStatus: EmbeddingStatus.PENDING,
      });

      // Verify noteIndexingService was called
      expect(noteIndexingService.indexNote).toHaveBeenCalledWith(mockEnv, mockNote);
    });

    it('should process image file content', async () => {
      // Mock note with image file
      const imageNote = {
        ...mockNote,
        contentType: 'image/jpeg',
        metadata: JSON.stringify({
          fileName: 'test.jpg',
          fileType: FileType.IMAGE,
          size: 500,
        }),
      };

      // Mock findById to return image note
      fileAttachmentService['noteRepository'].findById = jest.fn().mockResolvedValue(imageNote);

      // Call the service
      const result = await fileAttachmentService.processFileContent(mockEnv, mockNoteId);

      // Verify the result
      expect(result).toEqual(mockNote);

      // Verify fileProcessingService was called
      expect(fileProcessingService.extractTextFromImage).toHaveBeenCalledWith(mockEnv, mockR2Key);

      // Verify NoteRepository was called
      const noteRepo = fileAttachmentService['noteRepository'];
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNoteId, {
        body: 'Extracted image text content',
        metadata: expect.any(String),
        embeddingStatus: EmbeddingStatus.PENDING,
      });

      // Verify noteIndexingService was called
      expect(noteIndexingService.indexNote).toHaveBeenCalledWith(mockEnv, mockNote);
    });

    it('should throw error when note is not found', async () => {
      // Mock findById to return null
      fileAttachmentService['noteRepository'].findById = jest.fn().mockResolvedValue(null);

      // Call the service and expect it to throw
      await expect(fileAttachmentService.processFileContent(mockEnv, mockNoteId)).rejects.toThrow(
        `Note with ID ${mockNoteId} not found`,
      );
    });

    it('should throw error when note has no R2 key', async () => {
      // Mock note without R2 key
      const noteWithoutR2Key = {
        ...mockNote,
        r2Key: undefined,
      };

      // Mock findById to return note without R2 key
      fileAttachmentService['noteRepository'].findById = jest
        .fn()
        .mockResolvedValue(noteWithoutR2Key);

      // Call the service and expect it to throw
      await expect(fileAttachmentService.processFileContent(mockEnv, mockNoteId)).rejects.toThrow(
        `Note with ID ${mockNoteId} does not have an attached file`,
      );
    });
  });

  describe('deleteFileAttachment', () => {
    it('should delete a file attachment', async () => {
      // Call the service
      const result = await fileAttachmentService.deleteFileAttachment(mockEnv, mockNoteId);

      // Verify the result
      expect(result).toBe(true);

      // Verify r2Service was called
      expect(r2Service.deleteObject).toHaveBeenCalledWith(mockEnv, mockR2Key);

      // Verify NoteRepository was called
      const noteRepo = fileAttachmentService['noteRepository'];
      expect(noteRepo.update).toHaveBeenCalledWith(mockEnv, mockNoteId, {
        r2Key: undefined,
        metadata: undefined,
      });
    });

    it('should return false when note is not found', async () => {
      // Mock findById to return null
      fileAttachmentService['noteRepository'].findById = jest.fn().mockResolvedValue(null);

      // Call the service
      const result = await fileAttachmentService.deleteFileAttachment(mockEnv, mockNoteId);

      // Verify the result
      expect(result).toBe(false);

      // Verify r2Service was not called
      expect(r2Service.deleteObject).not.toHaveBeenCalled();
    });

    it('should return false when note has no R2 key', async () => {
      // Mock note without R2 key
      const noteWithoutR2Key = {
        ...mockNote,
        r2Key: undefined,
      };

      // Mock findById to return note without R2 key
      fileAttachmentService['noteRepository'].findById = jest
        .fn()
        .mockResolvedValue(noteWithoutR2Key);

      // Call the service
      const result = await fileAttachmentService.deleteFileAttachment(mockEnv, mockNoteId);

      // Verify the result
      expect(result).toBe(false);

      // Verify r2Service was not called
      expect(r2Service.deleteObject).not.toHaveBeenCalled();
    });

    it('should throw ServiceError when delete fails', async () => {
      // Mock r2Service.deleteObject to fail
      (r2Service.deleteObject as jest.Mock).mockRejectedValue(new Error('Delete failed'));

      // Call the service and expect it to throw
      await expect(fileAttachmentService.deleteFileAttachment(mockEnv, mockNoteId)).rejects.toThrow(
        ServiceError,
      );
    });
  });

  describe('getFileAttachment', () => {
    it('should get a file attachment', async () => {
      // Call the service
      const result = await fileAttachmentService.getFileAttachment(mockEnv, mockNoteId);

      // Verify the result
      expect(result).toEqual({
        data: expect.any(ReadableStream),
        contentType: 'text/plain',
      });

      // Verify r2Service was called
      expect(r2Service.downloadObject).toHaveBeenCalledWith(mockEnv, mockR2Key);
    });

    it('should return null when note is not found', async () => {
      // Mock findById to return null
      fileAttachmentService['noteRepository'].findById = jest.fn().mockResolvedValue(null);

      // Call the service
      const result = await fileAttachmentService.getFileAttachment(mockEnv, mockNoteId);

      // Verify the result
      expect(result).toBeNull();

      // Verify r2Service was not called
      expect(r2Service.downloadObject).not.toHaveBeenCalled();
    });

    it('should return null when note has no R2 key', async () => {
      // Mock note without R2 key
      const noteWithoutR2Key = {
        ...mockNote,
        r2Key: undefined,
      };

      // Mock findById to return note without R2 key
      fileAttachmentService['noteRepository'].findById = jest
        .fn()
        .mockResolvedValue(noteWithoutR2Key);

      // Call the service
      const result = await fileAttachmentService.getFileAttachment(mockEnv, mockNoteId);

      // Verify the result
      expect(result).toBeNull();

      // Verify r2Service was not called
      expect(r2Service.downloadObject).not.toHaveBeenCalled();
    });

    it('should return null when file is not found in R2', async () => {
      // Mock r2Service.downloadObject to return null
      (r2Service.downloadObject as jest.Mock).mockResolvedValue(null);

      // Call the service
      const result = await fileAttachmentService.getFileAttachment(mockEnv, mockNoteId);

      // Verify the result
      expect(result).toBeNull();
    });

    it('should throw ServiceError when download fails', async () => {
      // Mock r2Service.downloadObject to fail
      (r2Service.downloadObject as jest.Mock).mockRejectedValue(new Error('Download failed'));

      // Call the service and expect it to throw
      await expect(fileAttachmentService.getFileAttachment(mockEnv, mockNoteId)).rejects.toThrow(
        ServiceError,
      );
    });
  });
});
