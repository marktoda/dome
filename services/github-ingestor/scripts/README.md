# GitHub Ingestor Scripts

This directory contains utility scripts for the GitHub Ingestor service.

## redeploy-service.sh

This script helps redeploy the GitHub Ingestor service to fix initialization issues.

### Usage

```bash
# Make the script executable
chmod +x scripts/redeploy-service.sh

# Run the script
./scripts/redeploy-service.sh
```

### What it does

The script performs the following steps:

1. Builds the service using `pnpm build`
2. Deploys the service using `wrangler deploy`
3. Verifies the deployment by running diagnostic tests

If the deployment is still not working after running this script, it provides additional troubleshooting steps to check.

### Known Issues

There appears to be a D1 database error affecting the services. The error message `D1_ERROR: row value misused: SQLITE_ERROR` suggests there might be issues with the database schema or queries. This could be affecting both the github-ingestor service and other services like dome-api that use the same database.

## check-database.js

This script helps diagnose issues with the D1 database used by the GitHub Ingestor service.

### Usage

```bash
# Run the script
node scripts/check-database.js
```

### What it does

The script performs the following checks:

1. Retrieves the database schema to verify that all required tables exist
2. Checks for data in key tables:
   - provider_repositories
   - repository_sync_status
   - content_blobs
   - content_references

It uses the `wrangler d1` commands to interact with the database and provides detailed output about any issues found.

### Troubleshooting Database Issues

If the script identifies database issues, consider the following solutions:

1. Check if the database migrations have been applied
2. Verify that the database ID in wrangler.toml is correct
3. Run migrations manually with `wrangler d1 migrations apply <database-name>`
4. Check for any SQL syntax errors in the migrations
5. Ensure that the database schema matches what the code expects

## diagnose-service.js

This script performs a series of diagnostic tests on the GitHub Ingestor service to help identify and troubleshoot issues.

### Usage

```bash
# Run with default settings (using the deployed worker URL)
node scripts/diagnose-service.js

# Run with a custom worker URL
node scripts/diagnose-service.js --worker-url https://your-custom-url.workers.dev
```

### What it does

The script tests various endpoints of the GitHub Ingestor service and reports detailed information about the responses, including:

1. Status codes
2. Response headers
3. Response body content

It tests the following endpoints:

- `/` (root endpoint)
- `/health` (health check endpoint)
- `/status` (status endpoint)
- `/rpc` (RPC root)
- `/rpc/repositories` (repository management endpoint)

If the standard RPC endpoints fail, it also tries alternative paths to help identify the correct route structure.

### Interpreting Results

The script provides a diagnostic summary with possible issues and next steps based on the test results:

1. If all endpoints return 404 or 500 errors, the service may not be properly deployed or initialized.
2. If only RPC endpoints return 404 errors, the RPC routes may be registered differently than expected.
3. If you see 500 Internal Server errors, check the worker logs for more details.

## add-test-repos.js

This script adds test repositories to the GitHub Ingestor service for testing purposes.

### Prerequisites

- Node.js 18+ (with fetch API support)

### Installation

```bash
# No additional installation needed - the script uses built-in Node.js modules
cd services/github-ingestor
```

### Usage

```bash
# Run with default settings (using the deployed worker URL)
node scripts/add-test-repos.js

# Run with a custom worker URL
node scripts/add-test-repos.js --worker-url https://your-custom-url.workers.dev
```

### What it does

The script first performs a health check to verify that the GitHub Ingestor service is running and accessible. Then it adds the following repositories to the GitHub Ingestor:

- uniswap/v4-core
- uniswap/v3-core
- uniswap/v2-core
- uniswap/universal-router
- paradigmxyz/reth

For each repository, it:

1. Creates a repository entry in the GitHub Ingestor database
2. Triggers an initial sync to fetch and process the repository content
3. Waits between operations to avoid rate limiting

### Troubleshooting

If you encounter 404 errors when running the script, it could be due to one of the following issues:

1. The GitHub Ingestor service is not running or not accessible at the specified URL
2. The RPC endpoints are not properly registered or have a different path structure
3. The worker URL is incorrect

The script includes detailed error logging to help diagnose these issues. Check the console output for:

- The exact URLs being requested
- Response status codes and headers
- Response body content

### Configuration

You can modify the script to add different repositories or change the include/exclude patterns for file types. You can also specify a different worker URL using the `--worker-url` parameter.

The default include patterns are:

- `**/*.md` - Markdown files
- `**/*.sol` - Solidity files
- `**/*.js` - JavaScript files
- `**/*.ts` - TypeScript files
- `**/*.json` - JSON files
- `**/*.yml`, `**/*.yaml` - YAML files

The default exclude patterns are:

- `**/node_modules/**` - Node.js dependencies
- `**/dist/**` - Distribution directories
- `**/build/**` - Build directories
- `**/.git/**` - Git directories
- `**/artifacts/**` - Hardhat/Foundry artifacts
- `**/cache/**` - Hardhat/Foundry cache
