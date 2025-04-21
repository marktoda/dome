import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Configure Pulumi to use the specified stack
const stack = process.argv[2] || 'dev';
console.log(`Importing resources for stack: ${stack}`);

// Set the Pulumi stack
try {
  execSync(`pulumi stack select ${stack}`, { stdio: 'inherit' });
} catch (error) {
  console.error(`Failed to select stack: ${stack}`);
  process.exit(1);
}

// Import D1 Databases
async function importD1Databases() {
  console.log('Importing D1 Databases...');
  
  // Example: Import dome-meta database
  try {
    execSync(
      'pulumi import cloudflare:index/d1Database:D1Database dome-meta dome-meta',
      { stdio: 'inherit' }
    );
    console.log('Imported dome-meta database');
  } catch (error) {
    console.error('Failed to import dome-meta database');
  }
  
  // Example: Import silo database
  try {
    execSync(
      'pulumi import cloudflare:index/d1Database:D1Database silo silo',
      { stdio: 'inherit' }
    );
    console.log('Imported silo database');
  } catch (error) {
    console.error('Failed to import silo database');
  }
}

// Import R2 Buckets
async function importR2Buckets() {
  console.log('Importing R2 Buckets...');
  
  // Example: Import dome-raw bucket
  try {
    execSync(
      'pulumi import cloudflare:index/r2Bucket:R2Bucket dome-raw dome-raw',
      { stdio: 'inherit' }
    );
    console.log('Imported dome-raw bucket');
  } catch (error) {
    console.error('Failed to import dome-raw bucket');
  }
  
  // Example: Import silo-content bucket
  try {
    execSync(
      'pulumi import cloudflare:index/r2Bucket:R2Bucket silo-content silo-content',
      { stdio: 'inherit' }
    );
    console.log('Imported silo-content bucket');
  } catch (error) {
    console.error('Failed to import silo-content bucket');
  }
}

// Run the import process
async function runImport() {
  await importD1Databases();
  await importR2Buckets();
  // Add other import functions as needed
  
  console.log('Import process completed');
}

runImport().catch(error => {
  console.error('Import process failed:', error);
  process.exit(1);
});