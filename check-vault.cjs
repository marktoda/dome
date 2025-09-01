#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('Checking vault configuration...\n');

// Check environment
console.log('Environment:');
console.log(`  HOME: ${process.env.HOME}`);
console.log(`  USER: ${process.env.USER || 'not set'}`);
console.log(`  DOME_VAULT_PATH: ${process.env.DOME_VAULT_PATH || 'not set'}`);
console.log(`  Current directory: ${process.cwd()}`);
console.log(`  OS Home directory: ${os.homedir()}`);

// Check potential vault locations
const potentialPaths = [
  process.env.DOME_VAULT_PATH,
  path.join(process.env.HOME, 'dome'),
  path.join(os.homedir(), 'dome'),
  '/home/toda/dome',
  path.join(process.cwd(), 'dome'),
];

console.log('\nChecking potential vault locations:');
potentialPaths.forEach(vaultPath => {
  if (!vaultPath) return;
  
  try {
    if (fs.existsSync(vaultPath)) {
      const stats = fs.statSync(vaultPath);
      if (stats.isDirectory()) {
        const files = fs.readdirSync(vaultPath);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        console.log(`  ✓ ${vaultPath} - EXISTS (${mdFiles.length} .md files)`);
        
        // Check for 1-1 related files
        const oneOnOneFiles = files.filter(f => f.includes('1-1') || f.includes('1-on-1'));
        if (oneOnOneFiles.length > 0) {
          console.log(`      Found 1-1 related: ${oneOnOneFiles.slice(0, 3).join(', ')}`);
        }
      } else {
        console.log(`  × ${vaultPath} - EXISTS but not a directory`);
      }
    } else {
      console.log(`  × ${vaultPath} - DOES NOT EXIST`);
    }
  } catch (error) {
    console.log(`  × ${vaultPath} - ERROR: ${error.message}`);
  }
});

console.log('\nTo fix the issue:');
console.log('1. Set DOME_VAULT_PATH environment variable to your notes directory');
console.log('2. Or create a .env file with: DOME_VAULT_PATH=/path/to/your/notes');
console.log('3. Or move your notes to ~/dome/');