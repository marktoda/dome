import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { noteController } from '../../src/controllers/noteController';
import { noteService } from '../../src/services/noteService';
import { Note, EmbeddingStatus } from '../../src/models/note';
import { NotFoundError } from '@dome/common';

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

describe('Notes API Integration', () => {
  // Create a test app
  let app: Hono;

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

  // Mock note
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

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a new Hono app for each test
    app = new Hono();
    
    // Add middleware to set userId
    app.use('*', async (c, next) => {
      (c as any).set('userId', mockUserId);
      await next();
    });
    
    // Add routes
    app.post('/notes', noteController.ingest.bind(noteController));
    app.get('/notes/:id', noteController.getNote.bind(noteController));
    app.get('/notes', noteController.listNotes.bind(noteController));
    app.put('/notes/:id', noteController.updateNote.bind(noteController));
    app.delete('/notes/:id', noteController.deleteNote.bind(noteController));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /notes', () => {
    it('should create a note successfully', async () => {
      // Arrange
      vi.mocked(noteService.generateTitle).mockReturnValue('Generated Title');
      vi.mocked(noteService.createNote).mockResolvedValue(mockNote);

      // Create a test request
      const req = new Request('http://localhost/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: 'This is a test note',
          contentType: 'text/plain',
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data).toEqual({
        success: true,
        note: mockNote,
      });

      // Verify service was called with correct parameters
      expect(noteService.generateTitle).toHaveBeenCalledWith('This is a test note');
      expect(noteService.createNote).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          title: 'Generated Title',
          body: 'This is a test note',
          contentType: 'text/plain',
        }),
      );
    });

    it('should use provided title if available', async () => {
      // Arrange
      vi.mocked(noteService.createNote).mockResolvedValue({
        ...mockNote,
        title: 'Custom Title',
      });

      // Create a test request
      const req = new Request('http://localhost/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: 'This is a test note',
          contentType: 'text/plain',
          title: 'Custom Title',
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(201);
      
      // Verify service was called with correct parameters
      expect(noteService.generateTitle).not.toHaveBeenCalled();
      expect(noteService.createNote).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          userId: mockUserId,
          title: 'Custom Title',
          body: 'This is a test note',
          contentType: 'text/plain',
        }),
      );
    });

    it('should handle validation errors', async () => {
      // Arrange
      // Create a test request with missing required content
      const req = new Request('http://localhost/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contentType: 'text/plain',
          // Missing required content field
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });
  });

  describe('GET /notes/:id', () => {
    it('should get a note by ID successfully', async () => {
      // Arrange
      vi.mocked(noteService.getNoteById).mockResolvedValue(mockNote);

      // Create a test request
      const req = new Request('http://localhost/notes/note-123', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        success: true,
        note: mockNote,
      });

      // Verify service was called with correct parameters
      expect(noteService.getNoteById).toHaveBeenCalledWith(
        mockEnv,
        'note-123',
        mockUserId,
      );
    });

    it('should handle not found errors', async () => {
      // Arrange
      vi.mocked(noteService.getNoteById).mockRejectedValue(
        new NotFoundError('Note not found')
      );

      // Create a test request
      const req = new Request('http://localhost/notes/note-123', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });
  });

  describe('GET /notes', () => {
    it('should list notes successfully', async () => {
      // Arrange
      const mockNotes = [mockNote, { ...mockNote, id: 'note-456' }];
      vi.mocked(noteService.listNotes).mockResolvedValue({
        notes: mockNotes,
        count: 2,
        total: 2,
      });

      // Create a test request
      const req = new Request('http://localhost/notes?limit=10&offset=0', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        success: true,
        notes: mockNotes,
        count: 2,
        total: 2,
      });

      // Verify service was called with correct parameters
      expect(noteService.listNotes).toHaveBeenCalledWith(
        mockEnv,
        mockUserId,
        expect.objectContaining({
          limit: 10,
          offset: 0,
        }),
      );
    });

    it('should apply content type filter if provided', async () => {
      // Arrange
      vi.mocked(noteService.listNotes).mockResolvedValue({
        notes: [mockNote],
        count: 1,
        total: 1,
      });

      // Create a test request
      const req = new Request('http://localhost/notes?contentType=text/plain', {
        method: 'GET',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);

      // Verify service was called with correct parameters
      expect(noteService.listNotes).toHaveBeenCalledWith(
        mockEnv,
        mockUserId,
        expect.objectContaining({
          contentType: 'text/plain',
        }),
      );
    });
  });

  describe('PUT /notes/:id', () => {
    it('should update a note successfully', async () => {
      // Arrange
      const updatedNote = {
        ...mockNote,
        title: 'Updated Title',
        body: 'Updated content',
        updatedAt: 1617235679000,
      };
      vi.mocked(noteService.updateNote).mockResolvedValue(updatedNote);

      // Mock the dynamic import of updateNoteSchema
      vi.mock('../../src/models/note', async () => {
        const actual = await vi.importActual<any>('../../src/models/note');
        return {
          ...actual,
          updateNoteSchema: {
            parse: vi.fn().mockImplementation((data) => data),
          },
        };
      });

      // Create a test request
      const req = new Request('http://localhost/notes/note-123', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Updated Title',
          body: 'Updated content',
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        success: true,
        note: updatedNote,
      });

      // Verify service was called with correct parameters
      expect(noteService.updateNote).toHaveBeenCalledWith(
        mockEnv,
        'note-123',
        mockUserId,
        expect.objectContaining({
          title: 'Updated Title',
          body: 'Updated content',
        }),
      );
    });

    it('should handle not found errors', async () => {
      // Arrange
      vi.mocked(noteService.updateNote).mockRejectedValue(
        new NotFoundError('Note not found')
      );

      // Mock the dynamic import of updateNoteSchema
      vi.mock('../../src/models/note', async () => {
        const actual = await vi.importActual<any>('../../src/models/note');
        return {
          ...actual,
          updateNoteSchema: {
            parse: vi.fn().mockImplementation((data) => data),
          },
        };
      });

      // Create a test request
      const req = new Request('http://localhost/notes/note-123', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Updated Title',
        }),
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });
  });

  describe('DELETE /notes/:id', () => {
    it('should delete a note successfully', async () => {
      // Arrange
      vi.mocked(noteService.deleteNote).mockResolvedValue({
        success: true,
        message: 'Note deleted successfully',
      });

      // Create a test request
      const req = new Request('http://localhost/notes/note-123', {
        method: 'DELETE',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        success: true,
        message: 'Note deleted successfully',
      });

      // Verify service was called with correct parameters
      expect(noteService.deleteNote).toHaveBeenCalledWith(
        mockEnv,
        'note-123',
        mockUserId,
      );
    });

    it('should handle not found errors', async () => {
      // Arrange
      vi.mocked(noteService.deleteNote).mockRejectedValue(
        new NotFoundError('Note not found')
      );

      // Create a test request
      const req = new Request('http://localhost/notes/note-123', {
        method: 'DELETE',
      });

      // Add bindings to the request
      const reqWithBindings = Object.assign(req, {
        env: mockEnv,
      });

      // Act
      const res = await app.fetch(reqWithBindings);

      // Assert
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
    });
  });
});