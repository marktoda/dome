#!/usr/bin/env node

/**
 * Upload Neorg Files
 * 
 * This script finds all Neorg files in the user's home directory
 * and uploads them to dome using the CLI.
 */

const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

const execPromise = promisify(exec);

// Configuration
const HOME_DIR = os.homedir();
const NEORG_DIR = path.join(HOME_DIR, 'neorg');
const EXTENSIONS = ['.norg', '.md']; // Add other extensions if needed

// ASCII art banner
console.log(`
  _   _                        _   _       _                 _           
 | \\ | | ___  ___  _ __ __ _  | | | |_ __ | | ___   __ _  __| | ___ _ __ 
 |  \\| |/ _ \\/ _ \\| '__/ _\` | | | | | '_ \\| |/ _ \\ / _\` |/ _\` |/ _ \\ '__|
 | |\\  |  __/ (_) | | | (_| | | |_| | |_) | | (_) | (_| | (_| |  __/ |   
 |_| \\_|\\___|\\___/|_|  \\__, |  \\___/| .__/|_|\\___/ \\__,_|\\__,_|\\___|_|   
                       |___/        |_|                                  
`);

/**
 * Find all files recursively in a directory
 * @param {string} dir - Directory to search
 * @param {string[]} extensions - File extensions to filter by
 * @returns {Promise<string[]>} - List of file paths
 */
async function findFiles(dir, extensions) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        try {
          // Recursively search directories
          return await findFiles(fullPath, extensions);
        } catch (error) {
          console.error(`Error reading directory ${fullPath}: ${error.message}`);
          return [];
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          return [fullPath];
        }
      }
      return [];
    })
  );
  
  // Flatten the array of arrays
  return files.flat();
}

/**
 * Upload a file to dome
 * @param {string} filePath - Path to the file
 * @returns {Promise<boolean>} - Whether upload was successful
 */
async function uploadFile(filePath) {
  try {
    const relativeFilePath = filePath.replace(HOME_DIR, '~');
    console.log(`Uploading ${relativeFilePath}...`);
    
    await execPromise(`just cli add "${filePath}"`);
    
    console.log(`✅ Successfully uploaded: ${relativeFilePath}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to upload ${filePath}: ${err.message}`);
    return false;
  }
}

/**
 * Main function to find and upload files
 */
async function main() {
  try {
    console.log('🔍 Finding Neorg files...');
    
    // Check if neorg directory exists
    try {
      await fs.access(NEORG_DIR);
    } catch (error) {
      console.error(`❌ Error: Neorg directory not found at ${NEORG_DIR}`);
      console.log('Please make sure your Neorg directory exists at ~/neorg/');
      process.exit(1);
    }
    
    // Find all Neorg files
    const neorgFiles = await findFiles(NEORG_DIR, EXTENSIONS);
    
    console.log(`Found ${neorgFiles.length} Neorg files to upload.`);
    
    if (neorgFiles.length === 0) {
      console.log('No Neorg files found in your neorg directory.');
      return;
    }
    
    // Upload files one by one
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < neorgFiles.length; i++) {
      const file = neorgFiles[i];
      const success = await uploadFile(file);
      
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
      
      // Show progress
      console.log(`Progress: ${i + 1}/${neorgFiles.length} (${Math.round(((i + 1) / neorgFiles.length) * 100)}%)`);
    }
    
    // Summary
    console.log('\n🎉 Upload complete!');
    console.log(`📊 Summary:
  - Total files: ${neorgFiles.length}
  - Successfully uploaded: ${successCount}
  - Failed: ${failCount}`);
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Execute main function
main().catch(err => {
  console.error(`❌ Fatal error: ${err.message}`);
  process.exit(1);
});