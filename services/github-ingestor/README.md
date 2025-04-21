# GitHub Ingestor Service

The GitHub Ingestor service is responsible for ingesting data from GitHub repositories, processing it, and storing it in the Silo service. This service is a critical component in the content ingestion pipeline.

## Features

- Efficient ingestion of GitHub repositories via webhooks and scheduled fallback
- Processing of repository content to make it suitable for embedding
- Deduplication of content to optimize storage usage
- Streaming and chunking of large repositories to stay within Worker limits
- Proper error handling and retry mechanisms

## Setup

### Prerequisites

- Cloudflare Workers account with access to D1, Queues, and Service Bindings
- GitHub App for webhook integration and API access
- pnpm workspace setup

### Environment Variables Configuration

The service requires several GitHub-related environment variables that should be set using Cloudflare's secret management:

#### GitHub App Credentials

These credentials are used for webhook authentication and API access:

- `GITHUB_APP_ID`: The ID of your GitHub App
- `GITHUB_PRIVATE_KEY`: The private key for your GitHub App (PEM format)
- `GITHUB_WEBHOOK_SECRET`: The webhook secret for your GitHub App

#### GitHub API Access

These credentials are used for OAuth authentication and API access:

- `GITHUB_TOKEN`: A service account token for GitHub API access
- `GITHUB_CLIENT_ID`: The client ID for OAuth authentication
- `GITHUB_CLIENT_SECRET`: The client secret for OAuth authentication

#### Setting Up Secrets

To set up these secrets using Cloudflare Wrangler CLI:

```bash
# For production environment
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_PRIVATE_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_TOKEN
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET

# For development environment
wrangler secret put GITHUB_APP_ID --env dev
wrangler secret put GITHUB_PRIVATE_KEY --env dev
wrangler secret put GITHUB_WEBHOOK_SECRET --env dev
wrangler secret put GITHUB_TOKEN --env dev
wrangler secret put GITHUB_CLIENT_ID --env dev
wrangler secret put GITHUB_CLIENT_SECRET --env dev

# For staging environment
wrangler secret put GITHUB_APP_ID --env staging
wrangler secret put GITHUB_PRIVATE_KEY --env staging
wrangler secret put GITHUB_WEBHOOK_SECRET --env staging
wrangler secret put GITHUB_TOKEN --env staging
wrangler secret put GITHUB_CLIENT_ID --env staging
wrangler secret put GITHUB_CLIENT_SECRET --env staging
```

When prompted, enter the appropriate values for each secret.

### Database Setup and Migration

The GitHub Ingestor service uses Cloudflare D1 for database storage. The database schema includes tables for repository configuration, credentials, content blobs, and repository files.

#### Creating the Database

If you haven't created the D1 database yet:

```bash
# Create a new D1 database
wrangler d1 create github-ingestor

# This will output a database_id that you should update in your wrangler.toml file
```

#### Running Migrations

To set up or update the database schema:

```bash
# Apply migrations to production
wrangler d1 migrations apply github-ingestor

# Apply migrations to development
wrangler d1 migrations apply github-ingestor --env dev

# Apply migrations to staging
wrangler d1 migrations apply github-ingestor --env staging
```

#### Verifying Database Setup

To verify that your database is correctly set up:

```bash
# Run the database check script
node scripts/check-database.js
```

This script will check the database schema and report any issues.

## Deployment

### Development Environment

For local development and testing:

```bash
# Start the worker in development mode
wrangler dev

# Or using pnpm
pnpm run dev
```

### Staging Environment

For deploying to the staging environment:

```bash
# Deploy to staging
wrangler deploy --env staging

# Or using pnpm
pnpm run deploy:staging
```

### Production Environment

For deploying to the production environment:

```bash
# Deploy to production
wrangler deploy

# Or using pnpm
pnpm run deploy
```

## Testing

### Unit Tests

To run the unit test suite:

```bash
pnpm test
```

### Endpoint Testing

To test the service endpoints after deployment:

```bash
# Test endpoints with default URL (localhost:8787)
node test-endpoints.js

# Test endpoints with a specific URL
node test-endpoints.js https://github-ingestor.your-worker.workers.dev
```

This script tests the following endpoints:

- Root endpoint (/)
- Health endpoint (/health)
- Status endpoint (/status)

### Service Diagnostics

For more comprehensive service diagnostics:

```bash
# Run the diagnostic script with default URL
node scripts/diagnose-service.js

# Run the diagnostic script with a specific URL
node scripts/diagnose-service.js --worker-url https://github-ingestor.your-worker.workers.dev
```

This script performs a series of tests to diagnose issues with the GitHub Ingestor service.

## API Endpoints

- `GET /`: Service information
- `GET /health`: Health check endpoint
- `GET /status`: Detailed status information
- `POST /webhook`: GitHub webhook endpoint
- `/rpc/*`: RPC endpoints for internal service communication

## Monitoring

The service includes comprehensive logging and metrics collection:

- Structured logging with request IDs
- Health check metrics
- Queue processing metrics
- Error tracking

## Troubleshooting

If you encounter issues with the GitHub Ingestor service, refer to the [Troubleshooting Guide](./TROUBLESHOOTING.md) for detailed information on diagnosing and resolving common problems.

Quick troubleshooting steps:

1. Check the health endpoint for component status
2. Verify that all required environment variables are set
3. Check Cloudflare Workers logs for detailed error information
4. Ensure the database schema is properly initialized
5. Run the diagnostic scripts to identify specific issues
