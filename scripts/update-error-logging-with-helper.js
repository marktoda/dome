#!/usr/bin/env node

/**
 * Script to update error logging across the codebase to use the logError helper
 *
 * This script searches for patterns like:
 * - getLogger().error({ error }, 'message')
 * - logger.error({ error }, 'message')
 *
 * And replaces them with:
 * - logError(getLogger(), error, 'message')
 * - logError(logger, error, 'message')
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

// Process a file to update error logging
const processFile = filePath => {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // Check if the file already imports logError
    let hasLogErrorImport = content.includes('logError');

    // Find logger.error or getLogger().error calls
    const loggerErrorRegex =
      /(\s+)(logger|getLogger\(\))\.error\(\s*\{\s*([a-zA-Z0-9_]+)(\s*,\s*[^}]*)?\s*\}\s*,\s*['"]([^'"]+)['"]\s*\)/g;

    let match;
    let replacements = [];

    while ((match = loggerErrorRegex.exec(content)) !== null) {
      const indent = match[1];
      const logger = match[2];
      const errorVar = match[3];
      const additionalProps = match[4] || '';
      const message = match[5];
      const fullMatch = match[0];

      // Only replace if the error variable is actually named 'error'
      if (errorVar === 'error') {
        // Create the replacement using logError
        let additionalContext = '';
        if (additionalProps) {
          // Extract additional properties
          additionalContext = additionalProps.replace(/^\s*,\s*/, '');
          if (additionalContext) {
            additionalContext = `, { ${additionalContext} }`;
          }
        }

        const replacement = `${indent}logError(${logger}, error, '${message}'${additionalContext})`;

        replacements.push({
          start: match.index,
          end: match.index + fullMatch.length,
          original: fullMatch,
          replacement: replacement,
        });

        modified = true;
      }
    }

    // Find and remove redundant error message extraction lines
    const redundantExtractRegex =
      /\s+const\s+errorMessage\s*=\s*error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*String\s*\(\s*error\s*\)\s*;\s*\n/g;
    content = content.replace(redundantExtractRegex, '\n');

    // Apply replacements in reverse order to avoid offset issues
    replacements.sort((a, b) => b.start - a.start);

    for (const rep of replacements) {
      content = content.slice(0, rep.start) + rep.replacement + content.slice(rep.end);
    }

    // Add import for logError if needed and file was modified
    if (modified && !hasLogErrorImport) {
      // Check for existing imports from logging package
      const loggingImportRegex = /import\s+\{([^}]*)\}\s+from\s+['"]@dome\/logging['"]/;
      const loggingImportMatch = loggingImportRegex.exec(content);

      if (loggingImportMatch) {
        // Add logError to existing import
        const existingImports = loggingImportMatch[1];
        if (!existingImports.includes('logError')) {
          const newImports = existingImports.includes('getLogger')
            ? existingImports.replace('getLogger', 'getLogger, logError')
            : `${existingImports}, logError`;

          content = content.replace(
            loggingImportRegex,
            `import {${newImports}} from '@dome/logging'`,
          );
        }
      } else {
        // Add new import statement at the top of the file
        const importStatement = "import { logError } from '@dome/logging';\n";
        content = importStatement + content;
      }
    }

    if (modified) {
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

  console.log(`Updated ${updatedCount} files with improved error logging using logError helper`);
};

main();
