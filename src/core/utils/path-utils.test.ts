import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toAbs, toRel, isRel, isAbs } from './path-utils.js';
import * as path from 'node:path';

// Mock the config module
vi.mock('./config.js', () => ({
  config: {
    DOME_VAULT_PATH: '/home/user/vault'
  }
}));

describe('Path Utilities', () => {
  const vaultPath = '/home/user/vault';

  describe('toAbs', () => {
    it('should convert relative path to absolute path', () => {
      const relPath = 'notes/todo.md';
      const result = toAbs(relPath);
      expect(result).toBe(path.join(vaultPath, relPath));
      expect(result).toBe('/home/user/vault/notes/todo.md');
    });

    it('should handle empty string', () => {
      const result = toAbs('');
      expect(result).toBe(vaultPath);
    });

    it('should handle single file name', () => {
      const result = toAbs('note.md');
      expect(result).toBe(path.join(vaultPath, 'note.md'));
    });

    it('should handle paths with dots', () => {
      const result = toAbs('./notes/todo.md');
      expect(result).toBe(path.join(vaultPath, './notes/todo.md'));
    });

    it('should handle deeply nested paths', () => {
      const result = toAbs('a/b/c/d/e/file.md');
      expect(result).toBe(path.join(vaultPath, 'a/b/c/d/e/file.md'));
    });

    it('should handle already absolute paths by returning them unchanged', () => {
      const absPath = '/home/user/vault/notes/todo.md';
      const result = toAbs(absPath);
      // Should return absolute paths unchanged
      expect(result).toBe(absPath);
    });
  });

  describe('toRel', () => {
    it('should convert absolute path to relative path', () => {
      const absPath = '/home/user/vault/notes/todo.md';
      const result = toRel(absPath);
      expect(result).toBe('notes/todo.md');
    });

    it('should handle vault root path', () => {
      const result = toRel(vaultPath);
      expect(result).toBe('');
    });

    it('should handle file at vault root', () => {
      const absPath = '/home/user/vault/note.md';
      const result = toRel(absPath);
      expect(result).toBe('note.md');
    });

    it('should handle paths outside vault (returns relative path with ..)', () => {
      const absPath = '/home/user/other/file.md';
      const result = toRel(absPath);
      expect(result).toBe('../other/file.md');
    });

    it('should handle already relative paths by returning them unchanged', () => {
      const relPath = 'notes/todo.md';
      const result = toRel(relPath);
      // Should return relative paths unchanged
      expect(result).toBe('notes/todo.md');
    });

    it('should handle deeply nested absolute paths', () => {
      const absPath = '/home/user/vault/a/b/c/d/e/file.md';
      const result = toRel(absPath);
      expect(result).toBe('a/b/c/d/e/file.md');
    });
  });

  describe('isRel', () => {
    it('should return true for relative paths', () => {
      expect(isRel('notes/todo.md')).toBe(true);
      expect(isRel('./notes/todo.md')).toBe(true);
      expect(isRel('../notes/todo.md')).toBe(true);
      expect(isRel('todo.md')).toBe(true);
      expect(isRel('')).toBe(true);
    });

    it('should return false for absolute paths', () => {
      expect(isRel('/home/user/vault/notes/todo.md')).toBe(false);
      expect(isRel('/notes/todo.md')).toBe(false);
      expect(isRel('/')).toBe(false);
    });
  });

  describe('isAbs', () => {
    it('should return true for absolute paths', () => {
      expect(isAbs('/home/user/vault/notes/todo.md')).toBe(true);
      expect(isAbs('/notes/todo.md')).toBe(true);
      expect(isAbs('/')).toBe(true);
    });

    it('should return false for relative paths', () => {
      expect(isAbs('notes/todo.md')).toBe(false);
      expect(isAbs('./notes/todo.md')).toBe(false);
      expect(isAbs('../notes/todo.md')).toBe(false);
      expect(isAbs('todo.md')).toBe(false);
      expect(isAbs('')).toBe(false);
    });
  });

  describe('Integration scenarios', () => {
    it('should correctly round-trip paths', () => {
      const originalRel = 'notes/meetings/2024/standup.md';
      const abs = toAbs(originalRel);
      const backToRel = toRel(abs);
      expect(backToRel).toBe(originalRel);
    });

    it('should handle special characters in paths', () => {
      const relPath = 'notes/my-note_2024 (draft).md';
      const abs = toAbs(relPath);
      expect(abs).toBe(path.join(vaultPath, relPath));
      expect(toRel(abs)).toBe(relPath);
    });

    it('should handle paths with spaces', () => {
      const relPath = 'notes/my notes/daily note.md';
      const abs = toAbs(relPath);
      expect(abs).toBe(path.join(vaultPath, relPath));
      expect(toRel(abs)).toBe(relPath);
    });
  });
});