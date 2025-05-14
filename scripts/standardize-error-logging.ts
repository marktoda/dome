#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
// Assuming a logger utility exists at @common/utils/logger
// We will add the import dynamically later if needed.
// import logger from '@common/utils/logger';

interface Arguments {
  targetDirs: string[];
  dryRun: boolean;
  interactive: boolean;
  _: (string | number)[];
  $0: string;
}

const loggerImportStatement = "import logger from '@common/utils/logger';\n";

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .option('target-dirs', {
      alias: 'd',
      type: 'array',
      description: 'Specific directories to target (relative to project root)',
      default: ['infra/scripts', 'services'], // Default targets
      string: true,
    })
    .option('dry-run', {
      alias: 'n',
      type: 'boolean',
      description: 'Show what would be changed without modifying files',
      default: false,
    })
    .option('interactive', {
      alias: 'i',
      type: 'boolean',
      description: 'Ask for confirmation before each change',
      default: false,
    })
    .help()
    .alias('help', 'h')
    .parseAsync()) as Arguments;

  console.log('Starting error logging standardization...');
  console.log('Options:', argv);

  const targetPatterns = argv.targetDirs.flatMap(dir => [
    path.join(dir, '**/*.ts'), // General TS files in target dirs
    path.join(dir, '*/scripts/**/*.ts'), // Specific scripts pattern if services dir is listed
  ]);

  const excludePatterns = [
    '**/node_modules/**',
    '**/dist/**',
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/ui/**', // Exclude UI package
    '**/packages/cli/**', // Exclude CLI package
  ];

  console.log('Searching for files matching:', targetPatterns);
  console.log('Excluding patterns:', excludePatterns);

  // Resolve project root relative to the script's location (__dirname)
  const projectRoot = path.resolve(__dirname, '../'); // Assuming script is in /scripts

  const files = await glob(targetPatterns, {
    ignore: excludePatterns,
    nodir: true,
    absolute: true, // Use absolute paths for easier processing
    cwd: projectRoot, // Set cwd to project root
  });

  console.log(`Found ${files.length} potential files to process.`);

  for (const file of files) {
    const relativePath = path.relative(projectRoot, file);
    console.log(`\nProcessing file: ${relativePath}`);
    await processFile(file, relativePath, argv.dryRun, argv.interactive, projectRoot);
  }

  console.log('\nStandardization process finished.');
}

async function processFile(
  filePath: string,
  relativePath: string,
  dryRun: boolean,
  interactive: boolean,
  projectRoot: string,
) {
  try {
    let content = await fs.readFile(filePath, 'utf-8');
    let originalContent = content;
    let changesMade = false;
    let needsLoggerImport = false;

    // Regex to find console.error calls, potentially followed by process.exit
    // This regex tries to capture the console.error call and optionally the process.exit call on the same or next line
    // It avoids matching lines that already contain 'logger.error' to prevent re-processing.
    const consoleErrorRegex =
      /^(?!.*\b(?:logger|console)\.error\s*\(.*\);?\s*process\.exit\(\s*1\s*\);?)(.*console\.error\((.*?)\);?)(\s*process\.exit\(\s*1\s*\);?)?/gm;

    let match;
    const replacements: { index: number; old: string; new: string }[] = [];

    // Need to handle replacements carefully due to potential multi-line matches and index shifts
    let lastIndex = 0;
    let modifiedContent = '';

    while ((match = consoleErrorRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const consoleErrorCall = match[1]; // The console.error(...) part
      const args = match[2].trim(); // Arguments inside console.error()
      const processExitCall = match[3] || ''; // The process.exit(...) part, if present

      // Construct the replacement
      let replacement = `logger.error(${args});`;
      if (processExitCall) {
        replacement += processExitCall;
      }

      // Append content before the match
      modifiedContent += content.substring(lastIndex, match.index);

      console.log(`  Found potential replacement in ${relativePath}:`);
      console.log(`    OLD: ${fullMatch.trim()}`);
      console.log(`    NEW: ${replacement.trim()}`);

      let applyChange = true;
      if (interactive) {
        // Basic interactive prompt (replace with a proper library like inquirer if needed)
        const readline = require('readline').createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>(resolve => {
          readline.question('  Apply this change? (y/N) ', resolve);
        });
        readline.close();

        if (answer.toLowerCase() !== 'y') {
          console.log('  Skipping change.');
          applyChange = false;
        }
      }

      if (applyChange) {
        modifiedContent += replacement;
        needsLoggerImport = true; // Mark that we need the import
        changesMade = true;
      } else {
        // If skipping, append the original match
        modifiedContent += fullMatch;
      }

      // Update lastIndex to the end of the current match
      lastIndex = match.index + fullMatch.length;
    }

    // Append the rest of the content after the last match
    modifiedContent += content.substring(lastIndex);

    // Update content if changes were made
    if (changesMade) {
      content = modifiedContent;
    }

    // Add logger import if needed and not already present
    // Ensure path alias resolution works or use relative path
    // Trying relative path first
    const loggerRelativePath = path
      .relative(path.dirname(filePath), path.join(projectRoot, 'packages/common/src/utils/logger'))
      .replace(/\\/g, '/');
    const relativeLoggerImport = `import logger from '${
      loggerRelativePath.startsWith('.') ? '' : './'
    }${loggerRelativePath}';\n`;
    const aliasLoggerImport = `import logger from '@common/utils/logger';\n`;

    if (
      needsLoggerImport &&
      !content.includes('@common/utils/logger') &&
      !content.includes(loggerRelativePath)
    ) {
      // Prefer alias import if possible, fallback to relative
      // For simplicity in this script, let's just use the alias version.
      // A more robust solution might check tsconfig paths.
      content = aliasLoggerImport + content;
      console.log(`  Added logger import to ${relativePath}`);
      changesMade = true; // Ensure this is set if only import was added
    }

    if (changesMade) {
      if (dryRun) {
        console.log(`  [DRY RUN] Would modify ${relativePath}`);
        // Optional: Show diff here if needed (e.g., using 'diff' library)
        // console.log('--- OLD ---');
        // console.log(originalContent);
        // console.log('--- NEW ---');
        // console.log(content);
        // console.log('-----------');
      } else {
        await fs.writeFile(filePath, content, 'utf-8');
        console.log(`  Modified ${relativePath}`);
      }
    } else {
      console.log(`  No changes needed for ${relativePath}`);
    }
  } catch (error) {
    console.error(`  Failed to process file ${relativePath}:`, error);
  }
}

main().catch(error => {
  // Use console.error here as the logger might not be initialized or the script itself failed
  console.error('Script failed unexpectedly:', error);
  process.exit(1);
});
