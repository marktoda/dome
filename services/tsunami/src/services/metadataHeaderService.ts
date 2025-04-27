/**
 * Metadata Header Service
 *
 * This service is responsible for injecting metadata headers into content
 * before it is stored in Silo. The metadata headers provide information about
 * the source, content, and ingestion process.
 *
 * @module services/metadataHeaderService
 */

import { getLogger, getRequestId } from '@dome/logging';
import { ValidationError } from '@dome/errors';
import { assertValid } from '../utils/errors';
import { DomeMetadata } from '../types/metadata';

const logger = getLogger();

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
  const requestId = getRequestId();
  
  // Validate inputs
  assertValid(content !== null && content !== undefined, 'Content cannot be null or undefined', {
    operation: 'injectMetadataHeader',
    contentType: typeof content,
    requestId
  });
  
  assertValid(metadata !== null && metadata !== undefined, 'Metadata cannot be null or undefined', {
    operation: 'injectMetadataHeader',
    metadataType: typeof metadata,
    requestId
  });
  
  // Validate required metadata fields
  assertValid(
    metadata.source && typeof metadata.source === 'object',
    'Metadata must include a valid source object',
    { operation: 'injectMetadataHeader', requestId }
  );
  
  assertValid(
    metadata.content && typeof metadata.content === 'object',
    'Metadata must include a valid content object',
    { operation: 'injectMetadataHeader', requestId }
  );
  
  try {
    const metadataJson = JSON.stringify(metadata, null, 2);
    
    logger.debug({
      event: 'metadata_header_injected',
      sourceType: metadata.source.type,
      contentType: metadata.content.type,
      metadataSize: metadataJson.length,
      contentSize: content.length,
      requestId
    }, 'Injecting metadata header into content');
    
    return `${METADATA_START}
${metadataJson}
${METADATA_END}

${content}`;
  } catch (error) {
    logger.error({
      event: 'metadata_header_error',
      error: error instanceof Error ? error.message : String(error),
      requestId
    }, 'Error serializing metadata');
    
    throw new ValidationError('Failed to serialize metadata', {
      operation: 'injectMetadataHeader',
      error: error instanceof Error ? error.message : String(error),
      requestId
    });
  }
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
  const requestId = getRequestId();
  
  // Validate inputs
  assertValid(repository && repository.trim().length > 0, 'Repository cannot be empty', {
    operation: 'createGitHubMetadata',
    requestId
  });
  
  assertValid(path && path.trim().length > 0, 'Path cannot be empty', {
    operation: 'createGitHubMetadata',
    repository,
    requestId
  });
  
  assertValid(updatedAt && updatedAt.trim().length > 0, 'UpdatedAt cannot be empty', {
    operation: 'createGitHubMetadata',
    repository,
    path,
    requestId
  });
  
  assertValid(sizeBytes >= 0, 'Size must be a non-negative number', {
    operation: 'createGitHubMetadata',
    repository,
    path,
    sizeBytes,
    requestId
  });
  
  const metadata = {
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
      request_id: requestId || 'unknown',
    },
  };
  
  logger.debug({
    event: 'github_metadata_created',
    repository,
    path,
    language,
    sizeBytes,
    requestId
  }, 'Created GitHub metadata object');
  
  return metadata;
}

/**
 * Determines the programming language based on file extension
 *
 * @param path - The file path
 * @returns The programming language name
 */
export function getLanguageFromPath(path: string): string {
  const requestId = getRequestId();
  
  // Validate input
  assertValid(path && typeof path === 'string', 'Path must be a non-empty string', {
    operation: 'getLanguageFromPath',
    pathType: typeof path,
    requestId
  });
  
  // Extract extension safely
  const lastDotIndex = path.lastIndexOf('.');
  const extension = lastDotIndex >= 0 ? path.slice(lastDotIndex).toLowerCase() : '';
  
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
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.xml': 'xml',
    '.sql': 'sql',
    '.kt': 'kotlin',
    '.dart': 'dart',
  };
  
  const language = languageMap[extension] || 'plaintext';
  
  logger.debug({
    event: 'language_detected',
    path,
    extension,
    language,
    requestId
  }, `Detected language ${language} for file ${path}`);
  
  return language;
}
