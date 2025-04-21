import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Get command line arguments
const stack = process.argv[2] || 'dev';
const action = process.argv[3] || 'preview';
const skipValidation = process.argv.includes('--skip-validation');

// Validate stack name
const validStacks = ['dev', 'staging', 'prod'];
if (!validStacks.includes(stack)) {
  console.error(`Invalid stack: ${stack}. Must be one of: ${validStacks.join(', ')}`);
  process.exit(1);
}

// Check for production safeguards
if (stack === 'prod' && action === 'destroy') {
  console.error('ERROR: Destroying production resources is not allowed!');
  console.error('If you really need to destroy production resources, use the Pulumi CLI directly with appropriate permissions.');
  process.exit(1);
}

// Check for required tools
function checkRequiredTools() {
  console.log('Checking for required tools...');
  
  try {
    // Check for Pulumi CLI
    const pulumiVersion = execSync('pulumi version', { encoding: 'utf8' });
    console.log(`Pulumi CLI detected: ${pulumiVersion.trim()}`);
    
    // Check for Node.js
    const nodeVersion = execSync('node --version', { encoding: 'utf8' });
    console.log(`Node.js detected: ${nodeVersion.trim()}`);
    
    // Check if we're logged in to Pulumi
    try {
      execSync('pulumi whoami', { stdio: 'pipe' });
      console.log('Pulumi login verified');
    } catch (error) {
      console.error('Not logged in to Pulumi. Please run "pulumi login" first.');
      process.exit(1);
    }
  } catch (error) {
    console.error('Failed to verify required tools:', error);
    process.exit(1);
  }
}

// Install dependencies if needed
function installDependencies() {
  console.log('Checking for dependencies...');
  
  if (!fs.existsSync(path.join(__dirname, '../node_modules'))) {
    console.log('Installing dependencies...');
    try {
      execSync('pnpm install', { 
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
      });
      console.log('Dependencies installed successfully');
    } catch (error) {
      console.error('Failed to install dependencies:', error);
      process.exit(1);
    }
  } else {
    console.log('Dependencies already installed');
  }
}

// Set up environment variables
function setupEnvironment() {
  console.log(`Setting up environment for stack: ${stack}`);
  
  // Load environment variables from .env file if it exists
  const envFile = path.join(__dirname, `../.env.${stack}`);
  if (fs.existsSync(envFile)) {
    console.log(`Loading environment variables from ${envFile}`);
    require('dotenv').config({ path: envFile });
  } else {
    console.log(`No environment file found at ${envFile}, using existing environment variables`);
  }
}

// Select the Pulumi stack
function selectStack() {
  console.log(`Selecting Pulumi stack: ${stack}`);
  
  try {
    execSync(`pulumi stack select ${stack}`, { 
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
  } catch (error) {
    console.error(`Failed to select stack: ${stack}`);
    process.exit(1);
  }
}

// Build the TypeScript code
function buildProject() {
  console.log('Building TypeScript project...');
  
  try {
    execSync('pnpm run build', { 
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
  } catch (error) {
    console.error('Failed to build project:', error);
    process.exit(1);
  }
}

// Run validation
function validateDeployment() {
  if (skipValidation) {
    console.log('Skipping validation as requested');
    return;
  }
  
  console.log('Validating deployment...');
  
  try {
    execSync('pnpm run validate', { 
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
  } catch (error) {
    console.error('Validation failed:', error);
    
    // Ask for confirmation to continue
    if (action !== 'preview') {
      console.log('\nValidation failed. Do you want to continue anyway? (y/N)');
      const response = require('readline-sync').question('> ');
      if (response.toLowerCase() !== 'y') {
        console.log('Deployment aborted');
        process.exit(1);
      }
    }
  }
}

// Run the Pulumi action
function runPulumiAction() {
  console.log(`Running Pulumi ${action}...`);
  
  try {
    let command = '';
    
    switch (action) {
      case 'preview':
        command = 'pulumi preview';
        break;
      case 'up':
        command = 'pulumi up --yes';
        break;
      case 'destroy':
        if (stack === 'prod') {
          console.error('ERROR: Destroying production resources is not allowed!');
          process.exit(1);
        }
        command = 'pulumi destroy --yes';
        break;
      default:
        console.error(`Unknown action: ${action}`);
        process.exit(1);
    }
    
    execSync(command, { 
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
    
    console.log(`Pulumi ${action} completed successfully`);
  } catch (error) {
    console.error(`Pulumi ${action} failed:`, error);
    process.exit(1);
  }
}

// Verify deployment after completion
function verifyDeployment() {
  if (action !== 'up') {
    return; // Only verify after actual deployments
  }
  
  console.log('Verifying deployment...');
  
  try {
    // Run a refresh to ensure the state is up-to-date
    execSync('pulumi refresh --yes', { 
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
    
    // Get the stack outputs
    const outputJson = execSync('pulumi stack output --json', { 
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8'
    });
    
    const outputs = JSON.parse(outputJson);
    console.log('Deployment outputs:', JSON.stringify(outputs, null, 2));
    
    console.log('Deployment verification completed successfully');
  } catch (error) {
    console.error('Deployment verification failed:', error);
    // Don't exit with error here, as the deployment itself might have succeeded
  }
}

// Main function to run the deployment process
async function main() {
  console.log(`Starting deployment process for stack: ${stack}, action: ${action}`);
  
  checkRequiredTools();
  installDependencies();
  setupEnvironment();
  selectStack();
  buildProject();
  validateDeployment();
  runPulumiAction();
  verifyDeployment();
  
  console.log(`Deployment process for stack ${stack} completed successfully`);
}

// Run the main function
main().catch(error => {
  console.error('Deployment process failed:', error);
  process.exit(1);
});