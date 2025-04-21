#!/usr/bin/env ts-node

import { promises as fs } from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import chalk from 'chalk';

const execPromise = promisify(exec);

/**
 * Ingests all .norg files from ~/neorg into the system using `just cli add`
 */
async function ingestNorgFiles() {
  try {
    // Expand the ~ to the home directory
    const homeDir = os.homedir();
    const neorgDir = path.join(homeDir, 'neorg');
    
    console.log(chalk.blue(`Looking for .norg files in ${neorgDir}...`));
    
    // Find all .norg files
    const norgFiles = await glob('**/*.norg', { 
      cwd: neorgDir,
      absolute: true
    });
    
    if (norgFiles.length === 0) {
      console.log(chalk.yellow('No .norg files found.'));
      return;
    }
    
    console.log(chalk.green(`Found ${norgFiles.length} .norg files.`));
    
    // Process each file
    for (const [index, filePath] of norgFiles.entries()) {
      try {
        console.log(chalk.blue(`[${index + 1}/${norgFiles.length}] Processing ${path.relative(neorgDir, filePath)}...`));
        
        // Read the file content
        const content = await fs.readFile(filePath, 'utf-8');
        
        // Escape quotes in the content to prevent command injection
        const escapedContent = content.replace(/"/g, '\\"');
        
        // Execute the just cli add command
        const command = `just cli add "${escapedContent}"`;
        console.log(chalk.dim(`Executing: ${command.substring(0, 50)}...`));
        
        const { stdout, stderr } = await execPromise(command);
        
        // Check if the stderr contains a success message
        const isSuccess = stderr.includes('Content added successfully') ||
                          stdout.includes('Content added successfully');
        
        if (isSuccess) {
          console.log(chalk.green(`Successfully ingested ${path.relative(neorgDir, filePath)}`));
          
          // Combine stdout and stderr for logging if needed
          const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
          if (output && process.env.DEBUG) {
            console.log(chalk.dim('Output:'), output);
          }
        } else {
          console.error(chalk.red(`Error ingesting ${filePath}:`));
          if (stderr.trim()) {
            console.error(chalk.dim('Error output:'), stderr.trim());
          }
          if (stdout.trim()) {
            console.log(chalk.dim('Standard output:'), stdout.trim());
          }
        }
      } catch (fileError) {
        console.error(chalk.red(`Error processing ${filePath}:`), fileError);
      }
      
      // Add a small delay between files to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(chalk.green.bold(`Completed ingestion of ${norgFiles.length} .norg files.`));
  } catch (error) {
    console.error(chalk.red('Error ingesting .norg files:'), error);
    process.exit(1);
  }
}

// Run the function
ingestNorgFiles().catch(error => {
  console.error(chalk.red('Unhandled error:'), error);
  process.exit(1);
});