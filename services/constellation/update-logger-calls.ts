/**
 * Script to update logger calls in the codebase
 *
 * This script helps identify files that need to be updated to use the standardized logger.
 * It prints out the files and the number of logger calls that need to be updated.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);
const readFile = util.promisify(fs.readFile);

// Regex patterns to match logger calls
const LOGGER_PATTERNS = [
  /getLogger\(\)\.info\(/g,
  /getLogger\(\)\.debug\(/g,
  /getLogger\(\)\.warn\(/g,
  /getLogger\(\)\.error\(/g,
];

// Files to exclude
const EXCLUDE_FILES = ['standardizedLogger.ts', 'logging.ts', 'update-logger-calls.ts'];

// Directories to exclude
const EXCLUDE_DIRS = ['node_modules', 'dist', '.wrangler'];

/**
 * Check if a file should be processed
 */
function shouldProcessFile(filePath: string): boolean {
  const fileName = path.basename(filePath);

  // Only process TypeScript files
  if (!filePath.endsWith('.ts')) {
    return false;
  }

  // Exclude specific files
  if (EXCLUDE_FILES.includes(fileName)) {
    return false;
  }

  return true;
}

/**
 * Find all TypeScript files in a directory recursively
 */
async function findTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.includes(entry.name)) {
        const subFiles = await findTsFiles(fullPath);
        files.push(...subFiles);
      }
    } else if (shouldProcessFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Count logger calls in a file
 */
async function countLoggerCalls(filePath: string): Promise<number> {
  const content = await readFile(filePath, 'utf-8');
  let count = 0;

  for (const pattern of LOGGER_PATTERNS) {
    const matches = content.match(pattern);
    if (matches) {
      count += matches.length;
    }
  }

  return count;
}

/**
 * Main function
 */
async function main() {
  const srcDir = path.join(__dirname, 'src');
  const files = await findTsFiles(srcDir);

  console.log('Files with logger calls that need to be updated:');
  console.log('----------------------------------------------');

  let totalCalls = 0;

  for (const file of files) {
    const count = await countLoggerCalls(file);
    if (count > 0) {
      const relativePath = path.relative(__dirname, file);
      console.log(`${relativePath}: ${count} calls`);
      totalCalls += count;
    }
  }

  console.log('----------------------------------------------');
  console.log(`Total: ${totalCalls} logger calls to update`);
  console.log('\nTo update these calls, replace:');
  console.log('  getLogger().info(obj, "message")');
  console.log('with:');
  console.log('  logger.info(obj, "message")');
  console.log('\nOr for simple messages:');
  console.log('  getLogger().info("message")');
  console.log('with:');
  console.log('  logger.info("message")');
}

main().catch(console.error);
