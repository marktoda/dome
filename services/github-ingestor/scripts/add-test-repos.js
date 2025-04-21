#!/usr/bin/env node
/**
 * Add Test Repositories Script
 * 
 * This script adds a few public GitHub repositories to the GitHub Ingestor
 * for testing purposes. It uses the RPC API to add the repositories.
 * 
 * Usage:
 *   node add-test-repos.js [--worker-url URL]
 * 
 * Options:
 *   --worker-url URL  The URL of the GitHub Ingestor worker 
 *                     (default: https://github-ingestor.chatter-9999.workers.dev)
 */

const { randomBytes } = require('crypto');

// Simple ULID implementation since we can't use the ulid package
function generateId() {
  const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const random = randomBytes(10).toString('hex');
  return timestamp + random;
}

// List of public repositories to add
const TEST_REPOSITORIES = [
  { owner: 'uniswap', repo: 'v4-core', branch: 'main' },
  { owner: 'uniswap', repo: 'v3-core', branch: 'main' },
  { owner: 'uniswap', repo: 'v2-core', branch: 'master' },
  { owner: 'uniswap', repo: 'universal-router', branch: 'main' },
  { owner: 'paradigmxyz', repo: 'reth', branch: 'main' },
];

// Parse command line arguments
const args = process.argv.slice(2);
let workerUrl = 'https://github-ingestor.chatter-9999.workers.dev';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--worker-url' && i + 1 < args.length) {
    workerUrl = args[i + 1];
    i++;
  }
}

/**
 * Add a repository to the GitHub Ingestor
 */
async function addRepository(owner, repo, branch) {
  const id = generateId();
  
  console.log(`Adding repository ${owner}/${repo} (branch: ${branch}) with ID ${id}...`);
  
  try {
    const url = `${workerUrl}/rpc/repositories`;
    console.log(`Making request to: ${url}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id,
        userId: null, // System repository
        provider: 'github',
        owner,
        repo,
        branch,
        isPrivate: false,
        includePatterns: ['**/*.md', '**/*.sol', '**/*.js', '**/*.ts', '**/*.json', '**/*.yml', '**/*.yaml'],
        excludePatterns: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/artifacts/**', '**/cache/**']
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Response status: ${response.status} ${response.statusText}`);
      console.error(`Response headers:`, Object.fromEntries([...response.headers.entries()]));
      console.error(`Response body: ${errorText}`);
      throw new Error(`Failed to add repository: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log(`Successfully added repository ${owner}/${repo} with ID ${id}`);
    console.log(JSON.stringify(result, null, 2));
    return id;
  } catch (error) {
    console.error(`Error adding repository ${owner}/${repo}:`, error);
    return id; // Return the ID anyway for the next step
  }
}

/**
 * Trigger a sync for a repository
 */
async function syncRepository(id) {
  console.log(`Triggering sync for repository ${id}...`);
  
  try {
    const url = `${workerUrl}/rpc/repositories/${id}/sync`;
    console.log(`Making request to: ${url}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        force: true
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Response status: ${response.status} ${response.statusText}`);
      console.error(`Response headers:`, Object.fromEntries([...response.headers.entries()]));
      console.error(`Response body: ${errorText}`);
      throw new Error(`Failed to sync repository: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log(`Successfully triggered sync for repository ${id}`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error syncing repository ${id}:`, error);
  }
}

/**
 * Check if the worker is running
 */
async function checkHealth() {
  console.log(`Checking if the GitHub Ingestor is running at ${workerUrl}...`);
  
  try {
    const response = await fetch(`${workerUrl}/health`);
    
    if (response.ok) {
      const result = await response.json();
      console.log(`Health check successful:`, result);
      return true;
    } else {
      const errorText = await response.text();
      console.error(`Health check failed: ${response.status} ${response.statusText}`);
      console.error(`Response body: ${errorText}`);
      
      // Try the status endpoint as a fallback
      console.log(`Trying status endpoint as fallback...`);
      const statusResponse = await fetch(`${workerUrl}/status`);
      
      if (statusResponse.ok) {
        const statusResult = await statusResponse.json();
        console.log(`Status check successful:`, statusResult);
        return true;
      } else {
        const statusErrorText = await statusResponse.text();
        console.error(`Status check failed: ${statusResponse.status} ${statusResponse.statusText}`);
        console.error(`Response body: ${statusErrorText}`);
        return false;
      }
    }
  } catch (error) {
    console.error(`Error checking health:`, error);
    return false;
  }
}

/**
 * Main function
 */
async function main() {
  console.log(`Adding test repositories to GitHub Ingestor at ${workerUrl}...`);
  
  // Check if the worker is running
  const isHealthy = await checkHealth();
  
  if (!isHealthy) {
    console.warn(`WARNING: The GitHub Ingestor may not be running or accessible at ${workerUrl}`);
    console.log(`Continuing anyway...`);
  }
  
  // Add each repository
  for (const repo of TEST_REPOSITORIES) {
    const id = await addRepository(repo.owner, repo.repo, repo.branch);
    
    // Trigger a sync for the repository
    await syncRepository(id);
    
    // Wait a bit between repositories to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('Done!');
}

// Run the main function
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});