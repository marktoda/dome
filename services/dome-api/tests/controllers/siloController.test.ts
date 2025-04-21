import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { siloController } from '../../src/controllers/siloController';
import { siloService } from '../../src/services/siloService';
import { ServiceError } from '@dome/common';
import { z } from 'zod';

// Mock dependencies
vi.mock('../../src/services/siloService', () => ({
  siloService: {
    simplePut: vi.fn(),
    createUpload: vi.fn(),
    getContentAsNote: vi.fn(),
    getContentsAsNotes: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock logger
vi.mock('@dome/logging', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('SiloController', () => {
  // Mock environment
  const mockEnv = {
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
  };

  // Mock user ID
  const mockUserId = 'user-123';

  // Mock note
  const mockNote = {
    id: 'note-123',
    title: 'Test Note',
    body: 'This is a test note',
    category: 'note' as const, // Use const assertion to make TypeScript recognize this as a literal type
    mimeType: 'text/markdown' as const,
    createdAt: 1617235678000,
    updatedAt: 1617235678000,
    userId: mockUserId,
    size: 100,
  };

  // Create mock context
  const createMockContext = (
    options: {
      userId?: string;
      body?: any;
      params?: Record<string, string>;
      query?: Record<string, string>;
      path?: string;
      method?: string;
    } = {},
  ) => {
    const mockJson = vi.fn();
    const mockReq = {
      json: vi.fn().mockResolvedValue(options.body || {}),
      param: vi.fn(name => options.params?.[name] || null),
      query: vi.fn(name => options.query?.[name] || null),
      path: options.path || '/api/notes',
      method: options.method || 'GET',
    };

    return {
      env: mockEnv,
      req: mockReq,
      json: mockJson,
      get: vi.fn().mockImplementation(key => {
        if (key === 'userId') return options.userId || mockUserId;
        return null;
      }),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('simplePut', () => {
    it('should create a note successfully', async () => {
      // Arrange
      const mockBody = {
        body: 'This is a test note',
        category: 'note',
        mimeType: 'text/plain',
      };

      const mockContext = createMockContext({
        userId: mockUserId,
        body: mockBody,
        path: '/api/notes',
        method: 'POST',
      });

      vi.mocked(siloService.simplePut).mockResolvedValue({
        id: 'note-123',
        category: 'note' as const,
        mimeType: 'text/markdown' as const,
        size: 100,
        createdAt: Date.now(),
      });

      // Act
      const response = await siloController.simplePut(mockContext as any);

      // Assert
      expect(siloService.simplePut).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          ...mockBody,
          userId: mockUserId,
        }),
      );

      expect(mockContext.json).toHaveBeenCalledWith({ success: true, id: 'note-123' }, 201);
    });

    it('should handle validation errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        body: {
          // Missing required body field
          category: 'note',
          mimeType: 'text/plain',
        },
        path: '/api/notes',
        method: 'POST',
      });

      // Mock Zod error
      const zodError = new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
          path: ['body'],
          message: 'Body is required',
        },
      ]);

      // Mock the parse method to throw a ZodError
      vi.spyOn(z.ZodObject.prototype, 'parse').mockImplementation(() => {
        throw zodError;
      });

      // Act
      const response = await siloController.simplePut(mockContext as any);

      // Assert
      expect(siloService.simplePut).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: expect.any(Array),
          },
        },
        400,
      );
    });
  });

  describe('get', () => {
    it('should get a note successfully', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        params: { id: 'note-123' },
        path: '/api/notes/note-123',
        method: 'GET',
      });

      vi.mocked(siloService.getContentAsNote).mockResolvedValue(mockNote);

      // Act
      const response = await siloController.get(mockContext as any);

      // Assert
      expect(siloService.getContentAsNote).toHaveBeenCalledWith(mockEnv, 'note-123', mockUserId);

      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        note: mockNote,
      });
    });

    it('should handle not found errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        params: { id: 'non-existent-note' },
        path: '/api/notes/non-existent-note',
        method: 'GET',
      });

      vi.mocked(siloService.getContentAsNote).mockResolvedValue(null);

      // Act
      const response = await siloController.get(mockContext as any);

      // Assert
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: { code: 'NOT_FOUND', message: 'Note not found' },
        },
        404,
      );
    });

    it('should handle service errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        params: { id: 'note-123' },
        path: '/api/notes/note-123',
        method: 'GET',
      });

      const serviceError = new ServiceError('Failed to get note', {
        code: 'NOTE_ERROR',
        status: 503,
      });
      vi.mocked(siloService.getContentAsNote).mockRejectedValue(serviceError);

      // Act
      const response = await siloController.get(mockContext as any);

      // Assert
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'NOTE_ERROR',
            message: 'Failed to get note',
          },
        },
        503,
      );
    });
  });

  describe('batchGet', () => {
    it('should get multiple notes successfully', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        query: { ids: 'note-123,note-456' },
        path: '/api/notes/batch',
        method: 'GET',
      });

      const mockNotes = [
        mockNote,
        {
          ...mockNote,
          id: 'note-456',
          title: 'Another Note',
          category: 'note' as const,
          mimeType: 'text/markdown' as const,
        },
      ];
      vi.mocked(siloService.getContentsAsNotes).mockResolvedValue(mockNotes);

      // Act
      const response = await siloController.batchGet(mockContext as any);

      // Assert
      expect(siloService.getContentsAsNotes).toHaveBeenCalledWith(
        mockEnv,
        ['note-123', 'note-456'],
        mockUserId,
      );

      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        notes: mockNotes,
      });
    });

    it('should handle missing IDs', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        query: {}, // No IDs provided
        path: '/api/notes/batch',
        method: 'GET',
      });

      // Act
      const response = await siloController.batchGet(mockContext as any);

      // Assert
      expect(siloService.getContentsAsNotes).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'No IDs provided' },
        },
        400,
      );
    });
  });

  describe('ingest', () => {
    it('should ingest content and create a note successfully', async () => {
      // Arrange
      const mockBody = {
        content: 'This is a test note content',
        category: 'note',
        mimeType: 'text/plain',
        title: 'Test Note Title',
      };

      const mockContext = createMockContext({
        userId: mockUserId,
        body: mockBody,
        path: '/api/notes/ingest',
        method: 'POST',
      });

      vi.mocked(siloService.simplePut).mockResolvedValue({
        id: 'note-123',
        category: 'note' as const,
        mimeType: 'text/plain' as const,
        size: 100,
        createdAt: Date.now(),
      });
      vi.mocked(siloService.getContentAsNote).mockResolvedValue(mockNote);

      // Act
      const response = await siloController.ingest(mockContext as any);

      // Assert
      expect(siloService.simplePut).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          body: mockBody.content,
          category: mockBody.category,
          mimeType: mockBody.mimeType,
          userId: mockUserId,
        }),
      );

      expect(siloService.getContentAsNote).toHaveBeenCalledWith(mockEnv, 'note-123', mockUserId);

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          note: mockNote,
        },
        201,
      );
    });

    it('should handle validation errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        body: {
          // Missing required content field
          category: 'note',
          mimeType: 'text/plain',
        },
        path: '/api/notes/ingest',
        method: 'POST',
      });

      // Mock Zod error
      const zodError = new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          received: 'undefined',
          path: ['content'],
          message: 'Content is required',
        },
      ]);

      // Mock the parse method to throw a ZodError
      vi.spyOn(z.ZodObject.prototype, 'parse').mockImplementation(() => {
        throw zodError;
      });

      // Act
      const response = await siloController.ingest(mockContext as any);

      // Assert
      expect(siloService.simplePut).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: expect.any(Array),
          },
        },
        400,
      );
    });
  });

  describe('updateNote', () => {
    it('should update a note successfully', async () => {
      // Arrange
      const mockBody = {
        title: 'Updated Title',
        body: 'Updated content',
      };

      const mockContext = createMockContext({
        userId: mockUserId,
        body: mockBody,
        params: { id: 'note-123' },
        path: '/api/notes/note-123',
        method: 'PUT',
      });

      vi.mocked(siloService.getContentAsNote)
        .mockResolvedValueOnce(mockNote) // First call for existing note
        .mockResolvedValueOnce({
          ...mockNote,
          ...mockBody,
          category: 'note' as const,
          mimeType: 'text/markdown' as const,
        }); // Second call for updated note

      vi.mocked(siloService.simplePut).mockResolvedValue({
        id: 'note-123',
        category: 'note' as const,
        mimeType: 'text/plain' as const,
        size: 100,
        createdAt: Date.now(),
      });

      // Act
      const response = await siloController.updateNote(mockContext as any);

      // Assert
      expect(siloService.getContentAsNote).toHaveBeenCalledTimes(2);
      expect(siloService.simplePut).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          id: 'note-123',
          body: mockBody.body,
          userId: mockUserId,
        }),
      );

      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        note: expect.objectContaining({
          ...mockNote,
          ...mockBody,
        }),
      });
    });

    it('should handle not found errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        body: { title: 'Updated Title' },
        params: { id: 'non-existent-note' },
        path: '/api/notes/non-existent-note',
        method: 'PUT',
      });

      vi.mocked(siloService.getContentAsNote).mockResolvedValue(null);

      // Act
      const response = await siloController.updateNote(mockContext as any);

      // Assert
      expect(siloService.simplePut).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: { code: 'NOT_FOUND', message: 'Note not found' },
        },
        404,
      );
    });
  });

  describe('delete', () => {
    it('should delete a note successfully', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        params: { id: 'note-123' },
        path: '/api/notes/note-123',
        method: 'DELETE',
      });

      vi.mocked(siloService.delete).mockResolvedValue({ success: true });

      // Act
      const response = await siloController.delete(mockContext as any);

      // Assert
      expect(siloService.delete).toHaveBeenCalledWith(mockEnv, {
        id: 'note-123',
        userId: mockUserId,
      });

      expect(mockContext.json).toHaveBeenCalledWith({ success: true });
    });

    it('should handle service errors', async () => {
      // Arrange
      const mockContext = createMockContext({
        userId: mockUserId,
        params: { id: 'note-123' },
        path: '/api/notes/note-123',
        method: 'DELETE',
      });

      const serviceError = new ServiceError('Failed to delete note', {
        code: 'DELETE_ERROR',
        status: 503,
      });
      vi.mocked(siloService.delete).mockRejectedValue(serviceError);

      // Act
      const response = await siloController.delete(mockContext as any);

      // Assert
      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: false,
          error: {
            code: 'DELETE_ERROR',
            message: 'Failed to delete note',
          },
        },
        503,
      );
    });
  });
});
