#!/usr/bin/env node

/**
 * Script to remove redundant error message extraction lines
 *
 * This script searches for patterns like:
 * const errorMessage = error instanceof Error ? error.message : String(error);
 *
 * And removes them if they're followed by a logError call
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get all TypeScript files in the repository
const findTsFiles = () => {
  try {
    const output = execSync(
      'find services packages -type f -name "*.ts" | grep -v "node_modules" | grep -v "dist"',
    ).toString();
    return output.split('\n').filter(Boolean);
  } catch (error) {
    console.error('Error finding TypeScript files:', error);
    return [];
  }
};

// Process a file to remove redundant error message extraction lines
const processFile = filePath => {
  try {
    let content = fs.readFileSync(filePath, 'utf8');

    // Check if the file uses logError
    if (!content.includes('logError(')) {
      return false;
    }

    // Find and remove redundant error message extraction lines
    const originalContent = content;
    const redundantExtractRegex =
      /\s+const\s+errorMessage\s*=\s*error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*String\s*\(\s*error\s*\)\s*;\s*\n/g;
    content = content.replace(redundantExtractRegex, '\n');

    // Check if content was modified
    if (content !== originalContent) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Updated: ${filePath}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error(`Error processing file ${filePath}:`, error);
    return false;
  }
};

// Main function
const main = () => {
  const files = findTsFiles();
  console.log(`Found ${files.length} TypeScript files`);

  let updatedCount = 0;

  for (const file of files) {
    if (processFile(file)) {
      updatedCount++;
    }
  }

  console.log(`Removed redundant error message extraction lines from ${updatedCount} files`);
};

main();
