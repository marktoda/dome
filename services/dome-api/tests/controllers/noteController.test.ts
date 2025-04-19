import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { noteController } from '../../src/controllers/noteController';
import { noteService } from '../../src/services/noteService';
import { NotFoundError, ServiceError } from '@dome/common';
import { EmbeddingStatus, Note } from '../../src/models/note';

// Mock dependencies
vi.mock('../../src/services/noteService', () => ({
  noteService: {
    createNote: vi.fn(),
    getNoteById: vi.fn(),
    listNotes: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
    generateTitle: vi.fn(),
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

describe('NoteController', () => {
  // Mock environment
  const mockEnv = {
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    RAW: {} as R2Bucket,
    EVENTS: {} as Queue<any>,
    EMBED_QUEUE: {} as Queue<any>,
  };

  // Mock user ID
  const mockUserId = 'user-123';

  // Mock note data
  const mockNote: Note = {
    id: 'note-123',
    userId: mockUserId,
    title: 'Test Note',
    body: 'This is a test note',
    contentType: 'text/plain',
    createdAt: 1617235678000,
    updatedAt: 1617235678000,
    embeddingStatus: EmbeddingStatus.COMPLETED,
  };

  // Create mock context
  const createMockContext = (method = 'GET', path = '/notes', params: Record<string, string> = {}, body = {}) => {
    const mockJson = vi.fn().mockReturnValue({
      json: vi.fn(),
    });

    return {
      env: mockEnv,
      get: vi.fn().mockReturnValue(mockUserId),
      req: {
        method,
        path,
        param: vi.fn((key: string) => params[key]),
        query: vi.fn((key: string) => params[key] || ''),
        json: vi.fn().mockResolvedValue(body),
      },
      json: mockJson,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('ingest', () => {
    it('should create a note successfully', async () => {
      // Arrange
      const mockContext = createMockContext('POST', '/notes', {}, {
        content: 'This is a test note',
        contentType: 'text/plain',
      });

      vi.mocked(noteService.generateTitle).mockReturnValue('Test Note');
      vi.mocked(noteService.createNote).mockResolvedValue(mockNote);

      // Act
      const response = await noteController.ingest(mockContext as any);

      // Assert
      expect(noteService.createNote).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          title: 'Test Note',
          body: 'This is a test note',
          contentType: 'text/plain',
        }),
      );

      expect(mockContext.json).toHaveBeenCalledWith(
        {
          success: true,
          note: mockNote,
        },
        201,
      );
    });

    it('should use provided title if available', async () => {
      // Arrange
      const mockContext = createMockContext('POST', '/notes', {}, {
        content: 'This is a test note',
        contentType: 'text/plain',
        title: 'Custom Title',
      });

      vi.mocked(noteService.createNote).mockResolvedValue({
        ...mockNote,
        title: 'Custom Title',
      });

      // Act
      await noteController.ingest(mockContext as any);

      // Assert
      expect(noteService.createNote).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          title: 'Custom Title',
          body: 'This is a test note',
          contentType: 'text/plain',
        }),
      );
      expect(noteService.generateTitle).not.toHaveBeenCalled();
    });

    it('should handle errors during note creation', async () => {
      // Arrange
      const mockContext = createMockContext('POST', '/notes', {}, {
        content: 'This is a test note',
        contentType: 'text/plain',
      });

      const error = new ServiceError('Failed to create note');
      vi.mocked(noteService.createNote).mockRejectedValue(error);
      vi.mocked(noteService.generateTitle).mockReturnValue('Test Note');

      // Act & Assert
      await expect(noteController.ingest(mockContext as any)).rejects.toThrow(error);
    });

    it('should handle validation errors', async () => {
      // Arrange
      const mockContext = createMockContext('POST', '/notes', {}, {
        // Missing required content field
        contentType: 'text/plain',
      });

      // Act & Assert
      await expect(noteController.ingest(mockContext as any)).rejects.toThrow();
    });
  });

  describe('getNote', () => {
    it('should get a note by ID successfully', async () => {
      // Arrange
      const mockContext = createMockContext('GET', '/notes/note-123', { id: 'note-123' });
      vi.mocked(noteService.getNoteById).mockResolvedValue(mockNote);

      // Act
      const response = await noteController.getNote(mockContext as any);

      // Assert
      expect(noteService.getNoteById).toHaveBeenCalledWith(mockEnv, 'note-123', mockUserId);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        note: mockNote,
      });
    });

    it('should handle not found errors', async () => {
      // Arrange
      const mockContext = createMockContext('GET', '/notes/note-123', { id: 'note-123' });
      const error = new NotFoundError('Note not found');
      vi.mocked(noteService.getNoteById).mockRejectedValue(error);

      // Act & Assert
      await expect(noteController.getNote(mockContext as any)).rejects.toThrow(error);
    });
  });

  describe('listNotes', () => {
    it('should list notes successfully', async () => {
      // Arrange
      const mockContext = createMockContext('GET', '/notes', { limit: '10', offset: '0' });
      const mockNotes: Note[] = [mockNote, { ...mockNote, id: 'note-456' }];
      vi.mocked(noteService.listNotes).mockResolvedValue({
        notes: mockNotes,
        count: 2,
        total: 2,
      });

      // Act
      const response = await noteController.listNotes(mockContext as any);

      // Assert
      expect(noteService.listNotes).toHaveBeenCalledWith(mockEnv, mockUserId, {
        contentType: undefined,
        limit: 10,
        offset: 0,
      });
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        notes: mockNotes,
        count: 2,
        total: 2,
      });
    });

    it('should apply content type filter if provided', async () => {
      // Arrange
      const mockContext = createMockContext('GET', '/notes', { 
        contentType: 'text/plain',
        limit: '10', 
        offset: '0' 
      });
      
      vi.mocked(noteService.listNotes).mockResolvedValue({
        notes: [mockNote],
        count: 1,
        total: 1,
      });

      // Act
      await noteController.listNotes(mockContext as any);

      // Assert
      expect(noteService.listNotes).toHaveBeenCalledWith(mockEnv, mockUserId, {
        contentType: 'text/plain',
        limit: 10,
        offset: 0,
      });
    });

    it('should use default pagination if not provided', async () => {
      // Arrange
      const mockContext = createMockContext('GET', '/notes', {});
      vi.mocked(noteService.listNotes).mockResolvedValue({
        notes: [mockNote],
        count: 1,
        total: 1,
      });

      // Act
      await noteController.listNotes(mockContext as any);

      // Assert
      expect(noteService.listNotes).toHaveBeenCalledWith(mockEnv, mockUserId, {
        contentType: undefined,
        limit: 50,
        offset: 0,
      });
    });
  });

  describe('updateNote', () => {
    it('should update a note successfully', async () => {
      // Arrange
      const mockContext = createMockContext('PUT', '/notes/note-123', { id: 'note-123' }, {
        title: 'Updated Title',
        body: 'Updated content',
      });

      const updatedNote: Note = {
        ...mockNote,
        title: 'Updated Title',
        body: 'Updated content',
        updatedAt: 1617235679000,
      };

      vi.mocked(noteService.updateNote).mockResolvedValue(updatedNote);

      // Mock the dynamic import of updateNoteSchema
      vi.mock('../models/note', () => ({
        updateNoteSchema: {
          parse: vi.fn().mockImplementation((data) => data),
        },
      }));

      // Act
      const response = await noteController.updateNote(mockContext as any);

      // Assert
      expect(noteService.updateNote).toHaveBeenCalledWith(
        mockEnv,
        'note-123',
        mockUserId,
        expect.objectContaining({
          title: 'Updated Title',
          body: 'Updated content',
        }),
      );
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        note: updatedNote,
      });
    });

    it('should handle not found errors', async () => {
      // Arrange
      const mockContext = createMockContext('PUT', '/notes/note-123', { id: 'note-123' }, {
        title: 'Updated Title',
      });

      const error = new NotFoundError('Note not found');
      vi.mocked(noteService.updateNote).mockRejectedValue(error);

      // Mock the dynamic import of updateNoteSchema
      vi.mock('../models/note', () => ({
        updateNoteSchema: {
          parse: vi.fn().mockImplementation((data) => data),
        },
      }));

      // Act & Assert
      await expect(noteController.updateNote(mockContext as any)).rejects.toThrow(error);
    });
  });

  describe('deleteNote', () => {
    it('should delete a note successfully', async () => {
      // Arrange
      const mockContext = createMockContext('DELETE', '/notes/note-123', { id: 'note-123' });
      vi.mocked(noteService.deleteNote).mockResolvedValue({
        success: true,
        message: 'Note deleted successfully',
      });

      // Act
      const response = await noteController.deleteNote(mockContext as any);

      // Assert
      expect(noteService.deleteNote).toHaveBeenCalledWith(mockEnv, 'note-123', mockUserId);
      expect(mockContext.json).toHaveBeenCalledWith({
        success: true,
        message: 'Note deleted successfully',
      });
    });

    it('should handle not found errors', async () => {
      // Arrange
      const mockContext = createMockContext('DELETE', '/notes/note-123', { id: 'note-123' });
      const error = new NotFoundError('Note not found');
      vi.mocked(noteService.deleteNote).mockRejectedValue(error);

      // Act & Assert
      await expect(noteController.deleteNote(mockContext as any)).rejects.toThrow(error);
    });
  });
});