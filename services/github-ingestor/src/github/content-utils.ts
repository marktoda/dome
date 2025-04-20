import { minimatch } from 'minimatch';
import { initPolyfills } from '../utils/polyfills';

// Initialize polyfills
initPolyfills();

/**
 * Common MIME types for file extensions
 */
const MIME_TYPES: Record<string, string> = {
  // Text files
  'txt': 'text/plain',
  'md': 'text/markdown',
  'markdown': 'text/markdown',
  'html': 'text/html',
  'htm': 'text/html',
  'css': 'text/css',
  'csv': 'text/csv',
  'xml': 'text/xml',
  
  // Programming languages
  'js': 'application/javascript',
  'mjs': 'application/javascript',
  'cjs': 'application/javascript',
  'jsx': 'application/javascript',
  'ts': 'application/typescript',
  'tsx': 'application/typescript',
  'json': 'application/json',
  'py': 'text/x-python',
  'rb': 'text/x-ruby',
  'java': 'text/x-java',
  'c': 'text/x-c',
  'cpp': 'text/x-c++',
  'h': 'text/x-c',
  'hpp': 'text/x-c++',
  'cs': 'text/x-csharp',
  'go': 'text/x-go',
  'rs': 'text/x-rust',
  'php': 'text/x-php',
  'swift': 'text/x-swift',
  'kt': 'text/x-kotlin',
  'scala': 'text/x-scala',
  'pl': 'text/x-perl',
  'sh': 'text/x-shellscript',
  'bash': 'text/x-shellscript',
  'zsh': 'text/x-shellscript',
  'fish': 'text/x-shellscript',
  'sql': 'text/x-sql',
  'graphql': 'text/x-graphql',
  'yaml': 'text/yaml',
  'yml': 'text/yaml',
  'toml': 'text/toml',
  
  // Images
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'ico': 'image/x-icon',
  
  // Documents
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  
  // Archives
  'zip': 'application/zip',
  'tar': 'application/x-tar',
  'gz': 'application/gzip',
  'tgz': 'application/gzip',
  '7z': 'application/x-7z-compressed',
  'rar': 'application/x-rar-compressed',
  
  // Audio
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'ogg': 'audio/ogg',
  'flac': 'audio/flac',
  
  // Video
  'mp4': 'video/mp4',
  'webm': 'video/webm',
  'avi': 'video/x-msvideo',
  'mov': 'video/quicktime',
  
  // Fonts
  'ttf': 'font/ttf',
  'otf': 'font/otf',
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  
  // Other
  'wasm': 'application/wasm',
};

/**
 * Binary file extensions that should not be processed as text
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'tif',
  
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  
  // Archives
  'zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz',
  
  // Audio
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a',
  
  // Video
  'mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv',
  
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  
  // Other
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite', 'class',
  'jar', 'war', 'ear', 'pyc', 'pyo', 'o', 'obj', 'a', 'lib', 'out',
  'wasm', 'iso', 'img', 'dmg', 'pkg',
]);

/**
 * Common files to exclude from processing
 */
const DEFAULT_EXCLUDE_PATTERNS = [
  // Hidden files and directories
  '.*',
  '**/.*',
  '**/.*/**',
  
  // Build artifacts
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/out/**',
  '**/output/**',
  '**/bin/**',
  '**/obj/**',
  
  // Package manager files
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/poetry.lock',
  '**/Cargo.lock',
  
  // Large data files
  '**/*.min.js',
  '**/*.min.css',
  '**/*.bundle.js',
  '**/*.bundle.css',
  '**/*.chunk.js',
  '**/*.chunk.css',
  
  // Binary files
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.png',
  '**/*.gif',
  '**/*.webp',
  '**/*.ico',
  '**/*.pdf',
  '**/*.zip',
  '**/*.tar',
  '**/*.gz',
  '**/*.tgz',
  '**/*.7z',
  '**/*.rar',
  '**/*.mp3',
  '**/*.wav',
  '**/*.mp4',
  '**/*.webm',
  '**/*.ttf',
  '**/*.otf',
  '**/*.woff',
  '**/*.woff2',
  
  // Specific files
  '**/LICENSE',
  '**/CHANGELOG.md',
  '**/CONTRIBUTING.md',
  '**/AUTHORS',
  '**/CODEOWNERS',
];

/**
 * Get the MIME type for a file based on its extension
 * @param path File path
 * @returns MIME type
 */
export function getMimeType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[extension] || 'application/octet-stream';
}

/**
 * Check if a file is binary based on its extension
 * @param path File path
 * @returns Whether the file is binary
 */
export function isBinaryFile(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  return BINARY_EXTENSIONS.has(extension);
}

/**
 * Check if a file should be included based on include/exclude patterns
 * @param path File path
 * @param includePatterns Include patterns (null means include all)
 * @param excludePatterns Exclude patterns
 * @returns Whether the file should be included
 */
export function shouldIncludeFile(
  path: string,
  includePatterns: string[] | null = null,
  excludePatterns: string[] | null = null
): boolean {
  // Apply exclude patterns first (including defaults)
  const allExcludePatterns = [
    ...(excludePatterns || []),
    ...DEFAULT_EXCLUDE_PATTERNS,
  ];
  
  for (const pattern of allExcludePatterns) {
    if (minimatch(path, pattern, { dot: true })) {
      return false;
    }
  }
  
  // If no include patterns are specified, include all files
  if (!includePatterns || includePatterns.length === 0) {
    return true;
  }
  
  // Apply include patterns
  for (const pattern of includePatterns) {
    if (minimatch(path, pattern, { dot: true })) {
      return true;
    }
  }
  
  // If include patterns are specified but none match, exclude the file
  return false;
}

/**
 * Detect if content is likely binary based on a sample
 * @param content Content sample (first few bytes)
 * @returns Whether the content is likely binary
 */
export function isBinaryContent(content: Uint8Array): boolean {
  // Check for common binary file signatures
  if (content.length >= 4) {
    // PNG signature
    if (content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4E && content[3] === 0x47) {
      return true;
    }
    
    // JPEG signature
    if (content[0] === 0xFF && content[1] === 0xD8 && content[2] === 0xFF) {
      return true;
    }
    
    // GIF signature
    if (content[0] === 0x47 && content[1] === 0x49 && content[2] === 0x46 && content[3] === 0x38) {
      return true;
    }
    
    // PDF signature
    if (content[0] === 0x25 && content[1] === 0x50 && content[2] === 0x44 && content[3] === 0x46) {
      return true;
    }
    
    // ZIP signature
    if (content[0] === 0x50 && content[1] === 0x4B && content[2] === 0x03 && content[3] === 0x04) {
      return true;
    }
  }
  
  // Count null bytes and control characters
  let nullCount = 0;
  let controlCount = 0;
  
  for (let i = 0; i < Math.min(content.length, 1000); i++) {
    if (content[i] === 0) {
      nullCount++;
    } else if (content[i] < 9 || (content[i] > 13 && content[i] < 32)) {
      controlCount++;
    }
  }
  
  // If more than 10% of the first 1000 bytes are null or control characters, it's likely binary
  const threshold = Math.min(content.length, 1000) * 0.1;
  return nullCount > threshold || controlCount > threshold;
}

/**
 * Get a sample of content for binary detection
 * @param content Content as string or Uint8Array
 * @returns Content sample as Uint8Array
 */
export function getContentSample(content: string | Uint8Array): Uint8Array {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content.slice(0, 1000));
  } else {
    return content.slice(0, 1000);
  }
}

/**
 * Calculate SHA-1 hash of content
 * @param content Content as string or Uint8Array
 * @returns SHA-1 hash as hex string
 */
export async function calculateSha1(content: string | Uint8Array): Promise<string> {
  const data = typeof content === 'string'
    ? new TextEncoder().encode(content)
    : content;
  
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a unique R2 key for a content blob
 * @param sha SHA-1 hash of content
 * @param mimeType MIME type of content
 * @returns R2 key
 */
export function generateR2Key(sha: string, mimeType: string): string {
  return `blobs/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
}