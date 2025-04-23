/**
 * Metadata Header Service
 *
 * This service is responsible for injecting metadata headers into content
 * before it is stored in Silo. The metadata headers provide information about
 * the source, content, and ingestion process.
 *
 * @module services/metadataHeaderService
 */

import { DomeMetadata } from '../types/metadata';

// Constants for metadata header format
const METADATA_START = '---DOME-METADATA-START---';
const METADATA_END = '---DOME-METADATA-END---';
const METADATA_VERSION = '1.0';

/**
 * Injects a metadata header into the provided content
 *
 * @param content - The original content to inject the header into
 * @param metadata - The metadata to include in the header
 * @returns The content with the metadata header injected
 */
export function injectMetadataHeader(content: string, metadata: DomeMetadata): string {
  const metadataJson = JSON.stringify(metadata, null, 2);

  return `${METADATA_START}
${metadataJson}
${METADATA_END}

${content}`;
}

/**
 * Creates a metadata object for GitHub content
 *
 * @param repository - The repository identifier (owner/repo)
 * @param path - The file path within the repository
 * @param updatedAt - The timestamp when the content was last updated
 * @param language - The programming language of the content
 * @param sizeBytes - The size of the content in bytes
 * @returns A complete metadata object
 */
export function createGitHubMetadata(
  repository: string,
  path: string,
  updatedAt: string,
  language: string,
  sizeBytes: number,
): DomeMetadata {
  return {
    source: {
      type: 'github',
      repository,
      path,
      updated_at: updatedAt,
    },
    content: {
      type: 'code',
      language,
      size_bytes: sizeBytes,
    },
    ingestion: {
      timestamp: new Date().toISOString(),
      version: METADATA_VERSION,
    },
  };
}

/**
 * Determines the programming language based on file extension
 *
 * @param path - The file path
 * @returns The programming language name
 */
export function getLanguageFromPath(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();

  const languageMap: Record<string, string> = {
    '.js': 'javascript',
    '.ts': 'typescript',
    '.jsx': 'javascript',
    '.tsx': 'typescript',
    '.html': 'html',
    '.css': 'css',
    '.md': 'markdown',
    '.json': 'json',
    '.py': 'python',
    '.txt': 'plaintext',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.rs': 'rust',
    '.sh': 'shell',
  };

  return languageMap[extension] || 'plaintext';
}
