/**
 * Upload Test Repositories Script
 * 
 * This script adds initial public GitHub repositories to the Tsunami service
 * for testing and development purposes. It uses the Tsunami API to register
 * repositories for syncing.
 * 
 * Usage:
 *   npx tsx scripts/upload-test-repos.ts
 */

// Using native fetch API available in modern Node.js

// Configuration
const TSUNAMI_API_URL = 'https://tsunami.chatter-9999.workers.dev'; // Deployed tsunami service URL
const REPOSITORIES = [
  { owner: 'uniswap', repo: 'v4-core' },
  { owner: 'uniswap', repo: 'v3-core' },
];

/**
 * Response type for repository registration
 */
interface RepositoryResponse {
  success: boolean;
  id?: string;
  resourceId?: string;
  message?: string;
  error?: string;
}

/**
 * Register a GitHub repository with the Tsunami service
 *
 * @param owner - Repository owner (organization or user)
 * @param repo - Repository name
 * @returns Promise that resolves when the repository is registered
 */
async function registerRepository(owner: string, repo: string): Promise<void> {
  console.log(`Registering repository: ${owner}/${repo}...`);
  
  try {
    const response = await fetch(`${TSUNAMI_API_URL}/resource/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        owner,
        repo,
        // Using default cadence (1 hour)
      }),
    });
    
    const data = await response.json() as RepositoryResponse;
    
    if (!response.ok) {
      throw new Error(`Failed to register repository: ${data.message || data.error || response.statusText}`);
    }
    
    console.log(`✅ Successfully registered ${owner}/${repo}`);
    console.log(`   ID: ${data.id}`);
    console.log(`   Resource ID: ${data.resourceId}`);
  } catch (error) {
    console.error(`❌ Error registering ${owner}/${repo}:`, error);
    throw error;
  }
}

/**
 * Main function to register all repositories
 */
async function main() {
  console.log('Starting repository upload to Tsunami...');
  console.log(`Using Tsunami API at: ${TSUNAMI_API_URL}`);
  console.log('-------------------------------------------');
  
  // Register each repository sequentially
  for (const repo of REPOSITORIES) {
    try {
      await registerRepository(repo.owner, repo.repo);
    } catch (error) {
      // Log error but continue with other repositories
      console.error(`Failed to register ${repo.owner}/${repo.repo}. Continuing with next repository.`);
    }
    
    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('-------------------------------------------');
  console.log('Repository upload complete!');
}

// Run the script
main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});