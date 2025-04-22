#!/usr/bin/env node
/**
 * Upload Test Repositories Script
 * 
 * This script registers test GitHub repositories with the Tsunami service
 * for syncing and ingestion. It makes HTTP requests to the Tsunami API
 * to register each repository.
 * 
 * Usage:
 *   npx tsx scripts/upload-test-repos.ts
 */

// Using native fetch API available in Node.js 18+

// Configuration
const TSUNAMI_API_URL = 'https://tsunami.chatter-9999.workers.dev'; // Production URL
const REPOSITORIES = [
  {
    owner: 'uniswap',
    repo: 'v4-core',
    cadence: 'PT1H', // 1 hour in ISO 8601 duration format
  },
  {
    owner: 'paradigmxyz',
    repo: 'reth',
    cadence: 'PT1H', // 1 hour in ISO 8601 duration format
  },
];

/**
 * API response type definition
 */
interface ApiResponse {
  success: boolean;
  id: string;
  resourceId: string;
  message: string;
}

/**
 * Register a GitHub repository with the Tsunami service
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param cadence - Sync frequency in ISO 8601 duration format
 * @returns Promise that resolves to the API response
 */
async function registerRepository(owner: string, repo: string, cadence: string): Promise<ApiResponse> {
  console.log(`Registering repository: ${owner}/${repo}`);
  
  try {
    const response = await fetch(`${TSUNAMI_API_URL}/resource/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        owner,
        repo,
        cadence,
      }),
    });
    
    const data = await response.json() as ApiResponse;
    
    if (!response.ok) {
      throw new Error(`API error: ${(data as any).message || 'Unknown error'}`);
    }
    
    console.log(`✅ Successfully registered ${owner}/${repo}`);
    console.log(`   ID: ${data.id}`);
    console.log(`   Message: ${data.message}`);
    
    return data;
  } catch (error) {
    console.error(`❌ Failed to register ${owner}/${repo}`);
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Main function to register all repositories
 */
async function main() {
  console.log('Starting repository registration...');
  console.log(`API URL: ${TSUNAMI_API_URL}`);
  console.log('-----------------------------------');
  
  const results = [];
  
  for (const repo of REPOSITORIES) {
    try {
      const result = await registerRepository(repo.owner, repo.repo, repo.cadence);
      results.push({ ...repo, success: true, result });
    } catch (error) {
      results.push({ ...repo, success: false, error });
    }
    
    // Add a small delay between requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\nSummary:');
  console.log('-----------------------------------');
  
  const successful = results.filter(r => r.success).length;
  const failed = results.length - successful;
  
  console.log(`Total: ${results.length}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

// Run the script
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});