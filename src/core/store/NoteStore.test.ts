import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileSystemNoteStore, StoreType } from './NoteStore.js';
import { NoteId } from '../entities/Note.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock path-utils to avoid dependency on config
vi.mock('../utils/path-utils.js', () => ({
  toAbs: (relPath: string) => path.join('/test/vault', relPath),
  toRel: (absPath: string) => {
    if (!path.isAbsolute(absPath)) return absPath;
    return path.relative('/test/vault', absPath);
  }
}));

describe('FileSystemNoteStore', () => {
  let store: FileSystemNoteStore;
  let testDir: string;
  
  beforeEach(async () => {
    store = new FileSystemNoteStore();
    
    // Create a real temporary directory for testing
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notestore-test-'));
    
    // Mock toAbs to use our test directory
    vi.mock('../utils/path-utils.js', () => ({
      toAbs: (relPath: string) => path.join(testDir, relPath),
      toRel: (absPath: string) => {
        if (!path.isAbsolute(absPath)) return absPath;
        return path.relative(testDir, absPath);
      }
    }));
  });

  afterEach(async () => {
    // Clean up test directory
    if (testDir) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('get', () => {
    it('should get an existing note', async () => {
      const noteId = 'notes/test.md' as NoteId;
      const content = '# Test Note\nThis is test content';
      const notePath = path.join(testDir, noteId);
      
      // Create the note file
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, content);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      const result = await store.get(noteId);
      
      expect(result).not.toBeNull();
      expect(result?.id).toBe(noteId);
      expect(result?.body).toBe(content);
      expect(result?.fullPath).toBe(notePath);
    });

    it('should return null for non-existent note', async () => {
      const noteId = 'notes/missing.md' as NoteId;
      const notePath = path.join(testDir, noteId);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      const result = await store.get(noteId);
      
      expect(result).toBeNull();
    });

    it('should handle deeply nested notes', async () => {
      const noteId = 'a/b/c/d/e/deep.md' as NoteId;
      const content = 'Deep content';
      const notePath = path.join(testDir, noteId);
      
      // Create the note file
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, content);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      const result = await store.get(noteId);
      
      expect(result).not.toBeNull();
      expect(result?.body).toBe(content);
    });
  });

  describe('store', () => {
    it('should create a new note', async () => {
      const noteId = 'notes/new.md' as NoteId;
      const content = '# New Note';
      const notePath = path.join(testDir, noteId);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      const result = await store.store(noteId, content);
      
      expect(result.type).toBe(StoreType.Created);
      expect('oldContent' in result).toBe(false);
      
      // Verify file was created
      const savedContent = await fs.readFile(notePath, 'utf8');
      expect(savedContent).toBe(content);
    });

    it('should update an existing note', async () => {
      const noteId = 'notes/existing.md' as NoteId;
      const oldContent = '# Old Content';
      const newContent = '# New Content';
      const notePath = path.join(testDir, noteId);
      
      // Create the existing note
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, oldContent);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      const result = await store.store(noteId, newContent);
      
      expect(result.type).toBe(StoreType.Updated);
      expect('oldContent' in result && result.oldContent).toBe(oldContent);
      
      // Verify file was updated
      const savedContent = await fs.readFile(notePath, 'utf8');
      expect(savedContent).toBe(newContent);
    });

    it('should create parent directories if they do not exist', async () => {
      const noteId = 'new/deeply/nested/note.md' as NoteId;
      const content = 'Content';
      const notePath = path.join(testDir, noteId);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      const result = await store.store(noteId, content);
      
      expect(result.type).toBe(StoreType.Created);
      
      // Verify directories were created
      const dirExists = await fs.access(path.dirname(notePath)).then(() => true).catch(() => false);
      expect(dirExists).toBe(true);
      
      // Verify file was created
      const savedContent = await fs.readFile(notePath, 'utf8');
      expect(savedContent).toBe(content);
    });

    it('should handle notes without .md extension', async () => {
      const noteId = 'notes/noext' as NoteId;
      const content = 'Content without extension';
      const notePath = path.join(testDir, noteId) + '.md';
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(path.join(testDir, noteId));
      
      const result = await store.store(noteId, content);
      
      expect(result.type).toBe(StoreType.Created);
      
      // Verify file was created with .md extension
      const savedContent = await fs.readFile(notePath, 'utf8');
      expect(savedContent).toBe(content);
    });
  });

  describe('exists', () => {
    it('should return true for existing note', async () => {
      const noteId = 'notes/exists.md' as NoteId;
      const notePath = path.join(testDir, noteId);
      
      // Create the note file
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, 'content');
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      const result = await store.exists(noteId);
      
      expect(result).toBe(true);
    });

    it('should return false for non-existent note', async () => {
      const noteId = 'notes/missing.md' as NoteId;
      const notePath = path.join(testDir, noteId);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      const result = await store.exists(noteId);
      
      expect(result).toBe(false);
    });
  });

  describe('remove', () => {
    it('should remove an existing note', async () => {
      const noteId = 'notes/to-remove.md' as NoteId;
      const content = '# To Remove';
      const notePath = path.join(testDir, noteId);
      
      // Create the note file
      await fs.mkdir(path.dirname(notePath), { recursive: true });
      await fs.writeFile(notePath, content);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      const result = await store.remove(noteId);
      
      expect(result.removedContent).toBe(content);
      
      // Verify file was removed
      const fileExists = await fs.access(notePath).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);
    });

    it('should throw error when removing non-existent note', async () => {
      const noteId = 'notes/missing.md' as NoteId;
      const notePath = path.join(testDir, noteId);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs').mockReturnValue(notePath);
      
      await expect(store.remove(noteId)).rejects.toThrow();
    });
  });

  describe('rename', () => {
    it('should rename an existing note', async () => {
      const fromId = 'notes/old-name.md' as NoteId;
      const toId = 'notes/new-name.md' as NoteId;
      const content = '# Content';
      const fromPath = path.join(testDir, fromId);
      const toPath = path.join(testDir, toId);
      
      // Create the source note
      await fs.mkdir(path.dirname(fromPath), { recursive: true });
      await fs.writeFile(fromPath, content);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs')
        .mockReturnValueOnce(fromPath)
        .mockReturnValueOnce(toPath);
      
      await store.rename(fromId, toId);
      
      // Verify old file doesn't exist
      const oldExists = await fs.access(fromPath).then(() => true).catch(() => false);
      expect(oldExists).toBe(false);
      
      // Verify new file exists with same content
      const newContent = await fs.readFile(toPath, 'utf8');
      expect(newContent).toBe(content);
    });

    it('should create destination directory if needed', async () => {
      const fromId = 'notes/old.md' as NoteId;
      const toId = 'new/folder/new.md' as NoteId;
      const content = '# Content';
      const fromPath = path.join(testDir, fromId);
      const toPath = path.join(testDir, toId);
      
      // Create the source note
      await fs.mkdir(path.dirname(fromPath), { recursive: true });
      await fs.writeFile(fromPath, content);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs')
        .mockReturnValueOnce(fromPath)
        .mockReturnValueOnce(toPath);
      
      await store.rename(fromId, toId);
      
      // Verify new file exists in new directory
      const newContent = await fs.readFile(toPath, 'utf8');
      expect(newContent).toBe(content);
    });

    it('should throw error when source does not exist', async () => {
      const fromId = 'notes/missing.md' as NoteId;
      const toId = 'notes/new.md' as NoteId;
      const fromPath = path.join(testDir, fromId);
      const toPath = path.join(testDir, toId);
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs')
        .mockReturnValueOnce(fromPath)
        .mockReturnValueOnce(toPath);
      
      await expect(store.rename(fromId, toId)).rejects.toThrow();
    });

    it('should overwrite destination if it already exists', async () => {
      const fromId = 'notes/source.md' as NoteId;
      const toId = 'notes/dest.md' as NoteId;
      const sourceContent = 'Source content';
      const fromPath = path.join(testDir, fromId);
      const toPath = path.join(testDir, toId);
      
      // Create both files
      await fs.mkdir(path.dirname(fromPath), { recursive: true });
      await fs.writeFile(fromPath, sourceContent);
      await fs.writeFile(toPath, 'Dest content');
      
      // Mock toAbs for this test
      const pathUtils = await import('../utils/path-utils.js');
      vi.spyOn(pathUtils, 'toAbs')
        .mockReturnValueOnce(fromPath)
        .mockReturnValueOnce(toPath);
      
      await store.rename(fromId, toId);
      
      // Verify source was moved to destination
      const oldExists = await fs.access(fromPath).then(() => true).catch(() => false);
      expect(oldExists).toBe(false);
      
      // Verify destination has source content
      const newContent = await fs.readFile(toPath, 'utf8');
      expect(newContent).toBe(sourceContent);
    });
  });
});