/**
 * Default Ignore Patterns
 *
 * This file defines the default patterns that will be used to filter out
 * "garbage" files during ingestion if no .tsunamiignore file is present
 * in the repository.
 *
 * @module config/defaultIgnorePatterns
 */

/**
 * Default patterns to ignore during ingestion
 * These patterns will be used if no .tsunamiignore file is found
 */
export const DEFAULT_IGNORE_PATTERNS = [
  // Build artifacts and dependencies
  'node_modules/**',
  'dist/**',
  'build/**',
  '.next/**',
  'vendor/**',
  'target/**',
  'bin/**',
  'obj/**',
  
  // Package manager files
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  
  // Generated files
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.generated.*',
  
  // Binary and media files
  '*.jpg',
  '*.jpeg',
  '*.png',
  '*.gif',
  '*.ico',
  '*.svg',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.mp3',
  '*.mp4',
  '*.mov',
  '*.pdf',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.jar',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  
  // Cache and temporary files
  '.cache/**',
  '.tmp/**',
  'tmp/**',
  'temp/**',
  '*.log',
  
  // IDE and editor files
  '.idea/**',
  '.vscode/**',
  '.DS_Store',
  'Thumbs.db',
  
  // Test coverage and reports
  'coverage/**',
  '.nyc_output/**',
  'junit.xml',
  
  // Large data files
  '*.csv',
  '*.tsv',
  '*.sqlite',
  '*.db'
];