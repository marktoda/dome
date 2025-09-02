import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NoteService } from './NoteService.js';
import { NoteStore, StoreType } from '../store/NoteStore.js';
import { NoteId, RawNote, Note } from '../entities/Note.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Mock fast-glob
vi.mock('fast-glob', () => ({
  default: vi.fn()
}));

// Mock frontmatterService
vi.mock('./FrontmatterService.js', () => ({
  frontmatterService: {
    parse: vi.fn().mockReturnValue({
      data: {
        title: 'Test Title',
        tags: ['test', 'mock']
      },
      content: 'Test content'
    })
  }
}));

// Mock fs for stat
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn()
  };
});

// Mock path-utils to avoid issues with config
vi.mock('../utils/path-utils.js', () => ({
  toRel: (path: string) => {
    // If the path contains /vault/, extract everything after it
    if (path.includes('/vault/')) {
      return path.split('/vault/')[1];
    }
    // If already relative, return as-is
    if (!path.startsWith('/')) {
      return path;
    }
    // Otherwise just return the path
    return path;
  },
  toAbs: (path: string) => `/vault/${path}`,
  isRel: (path: string) => !path.startsWith('/'),
  isAbs: (path: string) => path.startsWith('/')
}));

describe('NoteService', () => {
  let noteService: NoteService;
  let mockStore: NoteStore;
  let fg: any;

  beforeEach(async () => {
    fg = (await import('fast-glob')).default as any;
    // Create mock store
    mockStore = {
      get: vi.fn(),
      store: vi.fn(),
      exists: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn()
    };

    noteService = new NoteService(mockStore);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('listNotes', () => {
    it('should list all notes from the vault', async () => {
      // Mock fast-glob to return file paths
      fg.mockResolvedValue(['notes/note1.md', 'notes/note2.md', 'inbox/note3.md']);

      // Mock store.get for each note
      const mockNotes: RawNote[] = [
        { id: 'notes/note1.md', body: '# Note 1\nContent 1', fullPath: '/vault/notes/note1.md' },
        { id: 'notes/note2.md', body: '# Note 2\nContent 2', fullPath: '/vault/notes/note2.md' },
        { id: 'inbox/note3.md', body: '# Note 3\nContent 3', fullPath: '/vault/inbox/note3.md' }
      ];

      mockStore.get = vi.fn()
        .mockResolvedValueOnce(mockNotes[0])
        .mockResolvedValueOnce(mockNotes[1])
        .mockResolvedValueOnce(mockNotes[2]);

      // Mock fs.stat
      (fs.stat as any).mockResolvedValue({ birthtime: new Date('2024-01-01') });

      const result = await noteService.listNotes();

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        id: 'notes/note1.md',
        title: 'Test Title',
        tags: ['test', 'mock'],
        path: 'notes/note1.md'
      });
      expect(fg).toHaveBeenCalledWith('**/*.md', expect.objectContaining({
        dot: false,
        ignore: ['**/node_modules/**', '**/.git/**']
      }));
    });

    it('should filter out null notes from store', async () => {
      fg.mockResolvedValue(['notes/note1.md', 'notes/missing.md']);

      mockStore.get = vi.fn()
        .mockResolvedValueOnce({ id: 'notes/note1.md', body: 'Content', fullPath: '/vault/notes/note1.md' })
        .mockResolvedValueOnce(null); // Missing note

      (fs.stat as any).mockResolvedValue({ birthtime: new Date('2024-01-01') });

      const result = await noteService.listNotes();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('notes/note1.md');
    });

    it('should handle empty vault', async () => {
      fg.mockResolvedValue([]);

      const result = await noteService.listNotes();

      expect(result).toHaveLength(0);
      expect(mockStore.get).not.toHaveBeenCalled();
    });
  });

  describe('getNote', () => {
    it('should get a specific note by ID', async () => {
      const noteId = 'notes/my-note.md' as NoteId;
      const mockRawNote: RawNote = {
        id: noteId,
        body: '# My Note\nContent here',
        fullPath: '/vault/notes/my-note.md'
      };

      mockStore.get = vi.fn().mockResolvedValue(mockRawNote);
      (fs.stat as any).mockResolvedValue({ birthtime: new Date('2024-01-01') });

      const result = await noteService.getNote(noteId);

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        id: noteId,
        title: 'Test Title',
        tags: ['test', 'mock'],
        path: noteId,
        body: '# My Note\nContent here'
      });
      expect(mockStore.get).toHaveBeenCalledWith(noteId);
    });

    it('should return null for non-existent note', async () => {
      const noteId = 'notes/missing.md' as NoteId;
      mockStore.get = vi.fn().mockResolvedValue(null);

      const result = await noteService.getNote(noteId);

      expect(result).toBeNull();
      expect(mockStore.get).toHaveBeenCalledWith(noteId);
    });

    it('should handle notes without frontmatter gracefully', async () => {
      const noteId = 'notes/plain.md' as NoteId;
      const mockRawNote: RawNote = {
        id: noteId,
        body: 'Plain text content',
        fullPath: '/vault/notes/plain.md'
      };

      mockStore.get = vi.fn().mockResolvedValue(mockRawNote);
      (fs.stat as any).mockResolvedValue({ birthtime: new Date('2024-01-01') });

      // Mock frontmatterService to throw error
      const { frontmatterService } = await import('./FrontmatterService.js');
      frontmatterService.parse = vi.fn().mockImplementation(() => {
        throw new Error('No frontmatter');
      });

      const result = await noteService.getNote(noteId);

      expect(result).not.toBeNull();
      expect(result?.title).toBe('plain'); // Should use filename
      expect(result?.tags).toEqual([]);
    });
  });

  describe('writeNote', () => {
    it('should write a new note', async () => {
      const noteId = 'notes/new.md' as NoteId;
      const content = '# New Note\nContent';
      
      mockStore.store = vi.fn().mockResolvedValue({ type: StoreType.Created });

      const result = await noteService.writeNote(noteId, content);

      expect(result.type).toBe(StoreType.Created);
      expect(mockStore.store).toHaveBeenCalledWith(noteId, content);
    });

    it('should update an existing note', async () => {
      const noteId = 'notes/existing.md' as NoteId;
      const content = '# Updated Note\nNew content';
      
      mockStore.store = vi.fn().mockResolvedValue({ 
        type: StoreType.Updated,
        oldContent: '# Old Note\nOld content'
      });

      const result = await noteService.writeNote(noteId, content);

      expect(result.type).toBe(StoreType.Updated);
      expect(result).toHaveProperty('oldContent');
      expect(mockStore.store).toHaveBeenCalledWith(noteId, content);
    });
  });

  describe('removeNote', () => {
    it('should remove a note', async () => {
      const noteId = 'notes/to-remove.md' as NoteId;
      const removedContent = '# Note to Remove\nContent';
      
      mockStore.remove = vi.fn().mockResolvedValue({ removedContent });

      const result = await noteService.removeNote(noteId);

      expect(result.removedContent).toBe(removedContent);
      expect(mockStore.remove).toHaveBeenCalledWith(noteId);
    });

    it('should throw error when removing non-existent note', async () => {
      const noteId = 'notes/missing.md' as NoteId;
      
      mockStore.remove = vi.fn().mockRejectedValue(new Error('File not found'));

      await expect(noteService.removeNote(noteId)).rejects.toThrow('File not found');
      expect(mockStore.remove).toHaveBeenCalledWith(noteId);
    });
  });

  describe('Edge cases', () => {
    it('should handle notes with special characters in path', async () => {
      const noteId = 'notes/my-note (2024).md' as NoteId;
      const mockRawNote: RawNote = {
        id: noteId,
        body: 'Content',
        fullPath: '/vault/notes/my-note (2024).md'
      };

      mockStore.get = vi.fn().mockResolvedValue(mockRawNote);
      (fs.stat as any).mockResolvedValue({ birthtime: new Date('2024-01-01') });
      
      // Re-mock frontmatterService for this test to ensure it works
      const { frontmatterService } = await import('./FrontmatterService.js');
      frontmatterService.parse = vi.fn().mockReturnValue({
        data: {
          title: 'Test Title',
          tags: ['test', 'mock']
        },
        content: 'Content'
      });

      const result = await noteService.getNote(noteId);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(noteId);
      expect(result?.title).toBe('Test Title');
    });

    it('should handle deeply nested notes', async () => {
      const noteId = 'a/b/c/d/e/deep.md' as NoteId;
      const mockRawNote: RawNote = {
        id: noteId,
        body: 'Deep content',
        fullPath: '/vault/a/b/c/d/e/deep.md'
      };

      mockStore.get = vi.fn().mockResolvedValue(mockRawNote);
      (fs.stat as any).mockResolvedValue({ birthtime: new Date('2024-01-01') });

      const result = await noteService.getNote(noteId);

      expect(result).not.toBeNull();
      expect(result?.path).toBe(noteId);
    });

    it('should handle notes at vault root', async () => {
      const noteId = 'root-note.md' as NoteId;
      const mockRawNote: RawNote = {
        id: noteId,
        body: 'Root content',
        fullPath: '/vault/root-note.md'
      };

      mockStore.get = vi.fn().mockResolvedValue(mockRawNote);
      (fs.stat as any).mockResolvedValue({ birthtime: new Date('2024-01-01') });

      const result = await noteService.getNote(noteId);

      expect(result).not.toBeNull();
      expect(result?.path).toBe(noteId);
    });
  });
});