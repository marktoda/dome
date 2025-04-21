#!/usr/bin/env node
/**
 * Add Test Repositories Script (Fixed Version)
 *
 * This script adds public GitHub repositories to the GitHub Ingestor
 * for testing purposes. It includes additional diagnostics and fallback paths.
 *
 * Usage:
 *   node add-test-repos-fixed.js [--worker-url URL]
 *
 * Options:
 *   --worker-url URL  The URL of the GitHub Ingestor worker
 *                     (default: https://github-ingestor.chatter-9999.workers.dev)
 */

// Simple ID generator that doesn't rely on crypto
function generateId() {
  const timestamp = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0');
  const random = Array.from({ length: 10 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
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

// Alternative API paths to try if the primary path fails
const API_PATHS = [
  '/rpc/repositories', // Primary path based on the code
  '/repositories', // Alternative without /rpc prefix
  '/api/repositories', // Alternative with /api prefix
];

/**
 * Add a repository to the GitHub Ingestor
 */
async function addRepository(owner, repo, branch) {
  const id = generateId();

  console.log(`Adding repository ${owner}/${repo} (branch: ${branch}) with ID ${id}...`);

  // Try each API path until one works
  for (const apiPath of API_PATHS) {
    try {
      const url = `${workerUrl}${apiPath}`;
      console.log(`Trying request to: ${url}`);

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
          includePatterns: [
            '**/*.md',
            '**/*.sol',
            '**/*.js',
            '**/*.ts',
            '**/*.json',
            '**/*.yml',
            '**/*.yaml',
          ],
          excludePatterns: [
            '**/node_modules/**',
            '**/dist/**',
            '**/build/**',
            '**/.git/**',
            '**/artifacts/**',
            '**/cache/**',
          ],
        }),
      });

      console.log(`Response status: ${response.status} ${response.statusText}`);
      console.log(`Response headers:`, Object.fromEntries([...response.headers.entries()]));

      const responseText = await response.text();
      console.log(`Response body: ${responseText}`);

      if (response.ok) {
        try {
          const result = JSON.parse(responseText);
          console.log(`Successfully added repository ${owner}/${repo} with ID ${id}`);
          console.log(JSON.stringify(result, null, 2));
          return { id, apiPath }; // Return both the ID and the successful API path
        } catch (parseError) {
          console.error(`Error parsing JSON response:`, parseError);
        }
      } else {
        console.error(
          `Failed to add repository: ${response.status} ${response.statusText} - ${responseText}`,
        );
      }
    } catch (error) {
      console.error(`Error making request to ${apiPath}:`, error);
    }
  }

  console.warn(`All API paths failed for ${owner}/${repo}. Returning ID for next step anyway.`);
  return { id, apiPath: null };
}

/**
 * Trigger a sync for a repository
 */
async function syncRepository(id, apiPath) {
  console.log(`Triggering sync for repository ${id}...`);

  // If we don't have a successful API path, try all paths
  const pathsToTry = apiPath
    ? [`${apiPath}/${id}/sync`]
    : API_PATHS.map(path => `${path}/${id}/sync`);

  for (const syncPath of pathsToTry) {
    try {
      const url = `${workerUrl}${syncPath}`;
      console.log(`Trying request to: ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          force: true,
        }),
      });

      console.log(`Response status: ${response.status} ${response.statusText}`);
      console.log(`Response headers:`, Object.fromEntries([...response.headers.entries()]));

      const responseText = await response.text();
      console.log(`Response body: ${responseText}`);

      if (response.ok) {
        try {
          const result = JSON.parse(responseText);
          console.log(`Successfully triggered sync for repository ${id}`);
          console.log(JSON.stringify(result, null, 2));
          return true;
        } catch (parseError) {
          console.error(`Error parsing JSON response:`, parseError);
        }
      } else {
        console.error(
          `Failed to sync repository: ${response.status} ${response.statusText} - ${responseText}`,
        );
      }
    } catch (error) {
      console.error(`Error making request to ${syncPath}:`, error);
    }
  }

  console.warn(`All sync paths failed for repository ${id}.`);
  return false;
}

/**
 * Check if the worker is running
 */
async function checkHealth() {
  console.log(`Checking if the GitHub Ingestor is running at ${workerUrl}...`);

  try {
    // Try health endpoint
    console.log(`Trying health endpoint...`);
    const healthResponse = await fetch(`${workerUrl}/health`);

    if (healthResponse.ok) {
      const result = await healthResponse.json();
      console.log(`Health check successful:`, result);
      return true;
    } else {
      const errorText = await healthResponse.text();
      console.error(`Health check failed: ${healthResponse.status} ${healthResponse.statusText}`);
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

        // Try a simple GET request to the root as a last resort
        console.log(`Trying root endpoint as last resort...`);
        const rootResponse = await fetch(workerUrl);

        if (rootResponse.ok) {
          console.log(
            `Root endpoint responded with ${rootResponse.status} ${rootResponse.statusText}`,
          );
          return true;
        } else {
          console.error(`Root endpoint failed: ${rootResponse.status} ${rootResponse.statusText}`);
          return false;
        }
      }
    }
  } catch (error) {
    console.error(`Error checking health:`, error);
    return false;
  }
}

/**
 * Diagnose service issues
 */
async function diagnoseService() {
  console.log(`Running diagnostics on ${workerUrl}...`);

  try {
    // Check if wrangler.toml exists and is properly configured
    console.log(`\nChecking service configuration...`);
    console.log(`1. Verify that the service is deployed with the correct routes`);
    console.log(`2. Check wrangler.toml for proper configuration`);
    console.log(`3. Ensure all required bindings (DB, queues) are set up`);

    // Test various endpoints
    console.log(`\nTesting various endpoints to identify routing issues...`);

    const endpoints = ['/', '/health', '/status', '/rpc', '/repositories', '/api/repositories'];

    for (const endpoint of endpoints) {
      try {
        const url = `${workerUrl}${endpoint}`;
        console.log(`Testing ${url}...`);

        const response = await fetch(url);
        console.log(`  Status: ${response.status} ${response.statusText}`);

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            const json = await response.json();
            console.log(`  Response: ${JSON.stringify(json).substring(0, 100)}...`);
          } catch {
            const text = await response.text();
            console.log(`  Response: ${text.substring(0, 100)}...`);
          }
        } else {
          const text = await response.text();
          console.log(`  Response: ${text.substring(0, 100)}...`);
        }
      } catch (error) {
        console.error(`  Error: ${error.message}`);
      }
    }

    console.log(
      `\nDiagnostic complete. Check the results above for clues about the service status.`,
    );
  } catch (error) {
    console.error(`Error running diagnostics:`, error);
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

    // Run diagnostics to help identify the issue
    await diagnoseService();

    const proceed = await promptToContinue();
    if (!proceed) {
      console.log(`Exiting as requested.`);
      return;
    }
  }

  // Add each repository
  for (const repo of TEST_REPOSITORIES) {
    const { id, apiPath } = await addRepository(repo.owner, repo.repo, repo.branch);

    // Trigger a sync for the repository
    await syncRepository(id, apiPath);

    // Wait a bit between repositories to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('Done!');
}

/**
 * Simple prompt to continue
 */
async function promptToContinue() {
  process.stdout.write(`Do you want to continue anyway? (y/N): `);

  return new Promise(resolve => {
    process.stdin.once('data', data => {
      const input = data.toString().trim().toLowerCase();
      resolve(input === 'y' || input === 'yes');
    });
  });
}

// Run the main function
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
