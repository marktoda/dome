/**
 * Metadata Header Service Tests
 */
import { describe, it, expect } from 'vitest';
import {
  injectMetadataHeader,
  createGitHubMetadata,
  getLanguageFromPath,
} from './metadataHeaderService';
import { DomeMetadata } from '../types/metadata';

describe('metadataHeaderService', () => {
  describe('injectMetadataHeader', () => {
    it('should inject metadata header into content', () => {
      // Arrange
      const content = 'function hello() {\n  return "world";\n}';
      const metadata: DomeMetadata = {
        source: {
          type: 'github',
          repository: 'owner/repo',
          path: 'hello.js',
          updated_at: '2023-04-22T12:34:56Z',
        },
        content: {
          type: 'code',
          language: 'javascript',
          size_bytes: 38,
        },
        ingestion: {
          timestamp: '2023-04-23T00:20:51Z',
          version: '1.0',
        },
      };

      // Act
      const result = injectMetadataHeader(content, metadata);

      // Assert
      expect(result).toContain('---DOME-METADATA-START---');
      expect(result).toContain('---DOME-METADATA-END---');
      expect(result).toContain('"repository": "owner/repo"');
      expect(result).toContain('"path": "hello.js"');
      expect(result).toContain('"language": "javascript"');
      expect(result).toContain(content);
    });
  });

  describe('createGitHubMetadata', () => {
    it('should create correct GitHub metadata object', () => {
      // Arrange
      const repository = 'owner/repo';
      const path = 'src/app.js';
      const updatedAt = '2023-04-22T12:34:56Z';
      const language = 'javascript';
      const sizeBytes = 1024;

      // Act
      const result = createGitHubMetadata(repository, path, updatedAt, language, sizeBytes);

      // Assert
      expect(result.source.type).toBe('github');
      expect(result.source.repository).toBe(repository);
      expect(result.source.path).toBe(path);
      expect(result.source.updated_at).toBe(updatedAt);
      expect(result.content.type).toBe('code');
      expect(result.content.language).toBe(language);
      expect(result.content.size_bytes).toBe(sizeBytes);
      expect(result.ingestion.version).toBe('1.0');
      expect(result.ingestion.timestamp).toBeDefined();
    });
  });

  describe('getLanguageFromPath', () => {
    it('should return correct language for known extensions', () => {
      expect(getLanguageFromPath('file.js')).toBe('javascript');
      expect(getLanguageFromPath('file.ts')).toBe('typescript');
      expect(getLanguageFromPath('file.py')).toBe('python');
      expect(getLanguageFromPath('file.md')).toBe('markdown');
      expect(getLanguageFromPath('file.go')).toBe('go');
    });

    it('should return plaintext for unknown extensions', () => {
      expect(getLanguageFromPath('file.xyz')).toBe('plaintext');
      expect(getLanguageFromPath('file')).toBe('plaintext');
    });
  });
});
