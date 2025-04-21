#!/usr/bin/env node
/**
 * GitHub Ingestor Service Diagnostic Script
 *
 * This script performs a series of tests to diagnose issues with the GitHub Ingestor service.
 * It checks various endpoints and reports detailed information about the responses.
 *
 * Usage:
 *   node diagnose-service.js [--worker-url URL]
 *
 * Options:
 *   --worker-url URL  The URL of the GitHub Ingestor worker
 *                     (default: https://github-ingestor.chatter-9999.workers.dev)
 */

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
 * Test an endpoint and report the results
 */
async function testEndpoint(path, method = 'GET', body = null) {
  const url = `${workerUrl}${path}`;
  console.log(`\n🔍 Testing ${method} ${url}`);

  try {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    console.log(`📊 Status: ${response.status} ${response.statusText}`);
    console.log(`📋 Headers:`);

    for (const [key, value] of response.headers.entries()) {
      console.log(`   ${key}: ${value}`);
    }

    let responseBody;
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      try {
        responseBody = await response.json();
        console.log(`📄 Body (JSON):`);
        console.log(JSON.stringify(responseBody, null, 2));
      } catch (error) {
        const text = await response.text();
        console.log(`📄 Body (Text - JSON parse failed):`);
        console.log(text);
      }
    } else {
      const text = await response.text();
      console.log(`📄 Body (Text):`);
      console.log(text);
    }

    return { success: response.ok, status: response.status, body: responseBody };
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Run all diagnostic tests
 */
async function runDiagnostics() {
  console.log(`🔧 Running diagnostics on ${workerUrl}\n`);

  // Test root endpoint
  await testEndpoint('/');

  // Test health endpoint
  await testEndpoint('/health');

  // Test status endpoint
  await testEndpoint('/status');

  // Test RPC root
  await testEndpoint('/rpc');

  // Test RPC repositories endpoint
  const repoTest = await testEndpoint('/rpc/repositories', 'POST', {
    id: 'test-repo-id',
    userId: null,
    provider: 'github',
    owner: 'test-owner',
    repo: 'test-repo',
    branch: 'main',
    isPrivate: false,
    includePatterns: ['**/*.md'],
    excludePatterns: ['**/node_modules/**'],
  });

  // If repositories endpoint failed, try with different paths
  if (!repoTest.success) {
    console.log('\n🔍 Testing alternative RPC paths...');

    // Test without /rpc prefix
    await testEndpoint('/repositories', 'POST', {
      id: 'test-repo-id',
      userId: null,
      provider: 'github',
      owner: 'test-owner',
      repo: 'test-repo',
      branch: 'main',
      isPrivate: false,
      includePatterns: ['**/*.md'],
      excludePatterns: ['**/node_modules/**'],
    });

    // Test with api prefix
    await testEndpoint('/api/repositories', 'POST', {
      id: 'test-repo-id',
      userId: null,
      provider: 'github',
      owner: 'test-owner',
      repo: 'test-repo',
      branch: 'main',
      isPrivate: false,
      includePatterns: ['**/*.md'],
      excludePatterns: ['**/node_modules/**'],
    });
  }

  console.log('\n📝 Diagnostic Summary:');
  console.log(
    '1. If all endpoints return 404 or 500 errors, the service may not be properly deployed or initialized.',
  );
  console.log(
    '2. If only RPC endpoints return 404 errors, the RPC routes may be registered differently than expected.',
  );
  console.log("3. Check the worker URL to ensure it's correct.");
  console.log('4. Verify that the service has the necessary permissions and bindings.');
  console.log('\n🔍 Next Steps:');
  console.log('1. Check the Cloudflare dashboard for any errors in the worker logs.');
  console.log("2. Verify the worker's bindings (D1 database, queues, etc.).");
  console.log('3. Try redeploying the service with `wrangler deploy`.');
  console.log("4. Check the service's source code to confirm the correct route structure.");
}

// Run the diagnostics
runDiagnostics().catch(error => {
  console.error(`❌ Fatal error: ${error.message}`);
  process.exit(1);
});
