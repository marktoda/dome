#!/usr/bin/env node

/**
 * Script to update error logging across the codebase
 *
 * This script searches for patterns like:
 * - getLogger().error({ error }, 'message')
 * - logger.error({ error }, 'message')
 *
 * And replaces them with:
 * - const errorMessage = error instanceof Error ? error.message : String(error);
 * - getLogger().error({ error, errorMessage }, 'message')
 * - logger.error({ error, errorMessage }, 'message')
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

// Regex patterns to match error logging
const loggerErrorRegex = /(\s+)(logger|getLogger\(\))\.error\(\s*\{\s*error(\s*,|\s*\})/g;
const errorVarRegex = /catch\s*\(\s*(\w+)\s*\)/g;

// Process a file to update error logging
const processFile = filePath => {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // Find all catch blocks and their error variable names
    const errorVars = [];
    let match;
    while ((match = errorVarRegex.exec(content)) !== null) {
      errorVars.push(match[1]);
    }

    // Skip if no error variables found
    if (errorVars.length === 0) {
      return false;
    }

    // For each error variable, check if it's used in logger.error without errorMessage
    for (const errorVar of errorVars) {
      const errorVarRegex = new RegExp(
        `(\\s+)(logger|getLogger\\(\\))\\.error\\(\\s*\\{\\s*${errorVar}(\\s*,|\\s*\\})`,
        'g',
      );

      // Check if the error variable is used in a logger.error call
      if (errorVarRegex.test(content)) {
        // Reset regex lastIndex
        errorVarRegex.lastIndex = 0;

        // Check if errorMessage is already included
        const errorMessageRegex = new RegExp(
          `const\\s+errorMessage\\s*=\\s*${errorVar}\\s+instanceof\\s+Error`,
        );
        if (!errorMessageRegex.test(content)) {
          // Find all logger.error calls with this error variable
          while ((match = errorVarRegex.exec(content)) !== null) {
            const indent = match[1];
            const logger = match[2];
            const position = match.index;

            // Find the start of the line
            let lineStart = content.lastIndexOf('\n', position) + 1;

            // Check if errorMessage extraction already exists before this line
            const prevLine = content.substring(
              content.lastIndexOf('\n', lineStart - 2) + 1,
              lineStart - 1,
            );
            if (!prevLine.includes(`const errorMessage = ${errorVar} instanceof Error`)) {
              // Insert errorMessage extraction before logger.error
              const errorMessageExtraction = `${indent}const errorMessage = ${errorVar} instanceof Error ? ${errorVar}.message : String(${errorVar});\n`;
              content =
                content.slice(0, lineStart) + errorMessageExtraction + content.slice(lineStart);

              // Update position after insertion
              const insertedLength = errorMessageExtraction.length;
              let newPosition = position + insertedLength;
              let newLineStart = lineStart + insertedLength;

              // Update the logger.error call to include errorMessage
              const loggerErrorCall = content.substring(
                newPosition,
                content.indexOf('\n', newPosition),
              );
              if (!loggerErrorCall.includes('errorMessage')) {
                // Find the logger.error call pattern
                const errorObjStart = loggerErrorCall.indexOf('{');
                const errorObjEnd = loggerErrorCall.indexOf('}', errorObjStart);

                if (errorObjStart !== -1 && errorObjEnd !== -1) {
                  // Insert errorMessage into the error object
                  const beforeObj = loggerErrorCall.substring(0, errorObjEnd);
                  const afterObj = loggerErrorCall.substring(errorObjEnd);

                  // Check if we need to add a comma
                  const needsComma = !beforeObj.trim().endsWith(',');
                  const updatedCall =
                    beforeObj + (needsComma ? ', errorMessage' : ' errorMessage') + afterObj;

                  content =
                    content.slice(0, newPosition) +
                    updatedCall +
                    content.slice(newPosition + loggerErrorCall.length);
                }
              }

              modified = true;
            }
          }
        }
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

  console.log(`Updated ${updatedCount} files with improved error logging`);
};

main();
