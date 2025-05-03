#!/usr/bin/env node

/**
 * This script scans all wrangler.toml files in the services directory
 * and adds the 'nodejs_compat' flag if not already present.
 *
 * This is required for AsyncLocalStorage functionality in our auth propagation system.
 * See docs/AUTH_PROPAGATION.md for more details.
 *
 * Usage:
 * 1. Install the required TOML package: npm install -g @iarna/toml
 * 2. Make this script executable: chmod +x scripts/add-als-compatibility.js
 * 3. Run the script: ./scripts/add-als-compatibility.js
 */

const fs = require('fs/promises');
const path = require('path');
const { parse, stringify } = require('@iarna/toml');

// Root directories
const servicesDir = path.resolve(__dirname, '../services');

async function scanDirectory(dir) {
  console.log(`Scanning directory: ${dir}`);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Look for wrangler.toml in this directory
      const wranglerPath = path.join(fullPath, 'wrangler.toml');
      try {
        await fs.access(wranglerPath);
        await processWranglerFile(wranglerPath);
      } catch (error) {
        // wrangler.toml doesn't exist in this directory
        // Continue scanning subdirectories
        await scanDirectory(fullPath);
      }
    }
  }
}

async function processWranglerFile(filePath) {
  console.log(`Processing: ${filePath}`);
  
  try {
    // Read the file
    const content = await fs.readFile(filePath, 'utf8');
    
    // Parse the TOML
    const config = parse(content);
    
    // Check if compatibility_flags exists and contains nodejs_compat or nodejs_als
    let modified = false;
    
    if (!config.compatibility_flags) {
      // No compatibility_flags array exists
      config.compatibility_flags = ["nodejs_compat"];
      modified = true;
    } else if (Array.isArray(config.compatibility_flags)) {
      // Check if nodejs_compat or nodejs_als already exists
      const hasNodeJsCompat = config.compatibility_flags.includes("nodejs_compat");
      const hasNodeJsAls = config.compatibility_flags.includes("nodejs_als");
      
      if (!hasNodeJsCompat && !hasNodeJsAls) {
        // Add nodejs_compat to the array
        config.compatibility_flags.push("nodejs_compat");
        modified = true;
      } else if (hasNodeJsAls && !hasNodeJsCompat) {
        // Replace nodejs_als with nodejs_compat as per task requirement
        const index = config.compatibility_flags.indexOf("nodejs_als");
        config.compatibility_flags[index] = "nodejs_compat";
        modified = true;
      }
    } else {
      // compatibility_flags exists but is not an array
      config.compatibility_flags = ["nodejs_compat"];
      modified = true;
    }
    
    if (modified) {
      // Add a comment explaining the AsyncLocalStorage requirement
      // Unfortunately, TOML libraries don't handle comments well, so we'll
      // need to do some string manipulation
      const serialized = stringify(config);
      
      // Find the compatibility_flags line
      const lines = serialized.split('\n');
      const flagsIndex = lines.findIndex(line => line.startsWith('compatibility_flags'));
      
      if (flagsIndex !== -1) {
        // Add a comment after the line
        lines.splice(flagsIndex + 1, 0, '# Required for AsyncLocalStorage in auth propagation system');
        
        // Write the file back
        await fs.writeFile(filePath, lines.join('\n'), 'utf8');
        console.log(`Updated ${filePath} - added nodejs_compat flag`);
      } else {
        // Just write the serialized config
        await fs.writeFile(filePath, serialized, 'utf8');
        console.log(`Updated ${filePath} - added compatibility_flags`);
      }
    } else {
      console.log(`No changes needed for ${filePath}`);
    }
    
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
  }
}

async function main() {
  try {
    // Add a package.json check to remind users to install @iarna/toml
    console.log('Note: This script requires @iarna/toml package. Install with: npm install -g @iarna/toml');
    
    console.log('Starting to scan services directory for wrangler.toml files...');
    await scanDirectory(servicesDir);
    console.log('Completed scanning all services.');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();