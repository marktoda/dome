import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Configure Pulumi to use the specified stack
const stack = process.argv[2] || 'dev';
console.log(`Validating resources for stack: ${stack}`);

// Set the Pulumi stack
try {
  execSync(`pulumi stack select ${stack}`, { stdio: 'inherit' });
} catch (error) {
  console.error(`Failed to select stack: ${stack}`);
  process.exit(1);
}

// Validate D1 Databases
async function validateD1Databases() {
  console.log('Validating D1 Databases...');

  try {
    // Run a preview to check for any changes
    const previewOutput = execSync('pulumi preview --json', { encoding: 'utf8' });
    const previewData = JSON.parse(previewOutput);

    // Check if there are any changes to D1 databases
    const d1Changes = previewData.steps.filter(
      (step: any) => step.resource && step.resource.type.includes('D1Database'),
    );

    if (d1Changes.length > 0) {
      console.warn(`Found ${d1Changes.length} changes to D1 databases`);
      d1Changes.forEach((change: any) => {
        console.warn(`- ${change.resource.type}: ${change.resource.name}`);
      });
    } else {
      console.log('No changes to D1 databases detected');
    }
  } catch (error) {
    console.error('Failed to validate D1 databases:', error);
  }
}

// Validate R2 Buckets
async function validateR2Buckets() {
  console.log('Validating R2 Buckets...');

  try {
    // Run a preview to check for any changes
    const previewOutput = execSync('pulumi preview --json', { encoding: 'utf8' });
    const previewData = JSON.parse(previewOutput);

    // Check if there are any changes to R2 buckets
    const r2Changes = previewData.steps.filter(
      (step: any) => step.resource && step.resource.type.includes('R2Bucket'),
    );

    if (r2Changes.length > 0) {
      console.warn(`Found ${r2Changes.length} changes to R2 buckets`);
      r2Changes.forEach((change: any) => {
        console.warn(`- ${change.resource.type}: ${change.resource.name}`);
      });
    } else {
      console.log('No changes to R2 buckets detected');
    }
  } catch (error) {
    console.error('Failed to validate R2 buckets:', error);
  }
}

// Run the validation process
async function runValidation() {
  await validateD1Databases();
  await validateR2Buckets();
  // Add other validation functions as needed

  console.log('Validation process completed');
}

runValidation().catch(error => {
  console.error('Validation process failed:', error);
  process.exit(1);
});
