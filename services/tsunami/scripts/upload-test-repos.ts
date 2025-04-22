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
  // Add more public repositories here as needed
  { owner: 'facebook', repo: 'react' },
  { owner: 'microsoft', repo: 'TypeScript' },
];

// Maximum number of retries for API requests
const MAX_RETRIES = 3;
// Delay between retries in milliseconds
const RETRY_DELAY = 2000;

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
 * Sleep for a specified number of milliseconds
 *
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the specified time
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Register a GitHub repository with the Tsunami service
 * Includes retry logic for transient errors
 *
 * @param owner - Repository owner (organization or user)
 * @param repo - Repository name
 * @returns Promise that resolves when the repository is registered
 */
async function registerRepository(owner: string, repo: string): Promise<void> {
  console.log(`Registering repository: ${owner}/${repo}...`);

  let retries = 0;
  let lastError: Error | null = null;

  while (retries < MAX_RETRIES) {
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

      const data = (await response.json()) as RepositoryResponse;

      if (!response.ok) {
        // Handle specific error cases
        if (response.status === 429) {
          throw new Error(
            `GitHub API rate limit exceeded. Please try again later or add a GitHub token.`,
          );
        } else if (response.status === 403) {
          throw new Error(
            `Access to GitHub repository is forbidden. Please check repository permissions or add a GitHub token.`,
          );
        } else if (response.status === 404) {
          throw new Error(`GitHub repository not found. Please check the owner and repo name.`);
        } else {
          throw new Error(
            `Failed to register repository: ${data.message || data.error || response.statusText}`,
          );
        }
      }

      console.log(`✅ Successfully registered ${owner}/${repo}`);
      console.log(`   ID: ${data.id}`);
      console.log(`   Resource ID: ${data.resourceId}`);
      return;
    } catch (error) {
      lastError = error as Error;
      retries++;

      if (retries < MAX_RETRIES) {
        console.warn(
          `⚠️ Attempt ${retries} failed for ${owner}/${repo}. Retrying in ${
            RETRY_DELAY / 1000
          } seconds...`,
        );
        await sleep(RETRY_DELAY);
      }
    }
  }

  console.error(`❌ Error registering ${owner}/${repo} after ${MAX_RETRIES} attempts:`, lastError);
  throw lastError;
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
      console.error(
        `Failed to register ${repo.owner}/${repo.repo}. Continuing with next repository.`,
      );
    }

    // Longer delay between repositories to avoid rate limiting
    await sleep(3000);
  }

  console.log('-------------------------------------------');
  console.log('Repository upload complete!');

  // Always show helpful message about rate limiting
  console.log("\nIf you're seeing rate limit errors, consider:");
  console.log('1. Adding a GitHub token to .dev.vars (GITHUB_TOKEN=your_token)');
  console.log('2. Reducing the number of repositories in the REPOSITORIES array');
  console.log('3. Increasing the delay between requests');
}

// Run the script
main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
