# GitHub Ingestor Troubleshooting Guide

This guide provides solutions for common issues you might encounter when working with the GitHub Ingestor service.

## Diagnostic Tools

The GitHub Ingestor service includes several diagnostic tools to help identify and resolve issues:

### Endpoint Testing Script

The `test-endpoints.js` script tests the basic endpoints of the service:

```bash
# Test with default URL (localhost:8787)
node test-endpoints.js

# Test with a specific URL
node test-endpoints.js https://github-ingestor.your-worker.workers.dev
```

### Service Diagnostic Script

The `scripts/diagnose-service.js` script performs more comprehensive tests:

```bash
# Run with default URL
node scripts/diagnose-service.js

# Run with a specific URL
node scripts/diagnose-service.js --worker-url https://github-ingestor.your-worker.workers.dev
```

### Database Check Script

The `scripts/check-database.js` script verifies the database schema and data:

```bash
node scripts/check-database.js
```

## Common Issues and Solutions

### Deployment Issues

#### 404 Errors on All Endpoints

**Symptoms**: All endpoints return 404 errors.

**Possible Causes**:

- The worker is not properly deployed
- The worker URL is incorrect

**Solutions**:

1. Verify the worker is deployed using the Cloudflare dashboard
2. Check the worker URL
3. Try redeploying the worker:
   ```bash
   wrangler deploy
   ```

#### 500 Errors on All Endpoints

**Symptoms**: All endpoints return 500 errors.

**Possible Causes**:

- Missing environment variables
- Database connection issues
- Service binding issues

**Solutions**:

1. Verify all required environment variables are set
2. Check the database connection in the Cloudflare dashboard
3. Verify service bindings in wrangler.toml
4. Check the worker logs in the Cloudflare dashboard

### Database Issues

#### Missing Tables

**Symptoms**: Database operations fail, or the check-database.js script reports missing tables.

**Possible Causes**:

- Migrations have not been applied
- Wrong database ID in wrangler.toml

**Solutions**:

1. Apply migrations:
   ```bash
   wrangler d1 migrations apply github-ingestor
   ```
2. Verify the database ID in wrangler.toml
3. Check for SQL syntax errors in the migrations

#### Data Integrity Issues

**Symptoms**: Unexpected behavior, missing data, or duplicate entries.

**Possible Causes**:

- Concurrent operations without proper locking
- Failed transactions
- Bugs in data handling code

**Solutions**:

1. Run the database check script to identify issues:
   ```bash
   node scripts/check-database.js
   ```
2. Manually inspect the data using D1 execute commands:
   ```bash
   wrangler d1 execute github-ingestor --command "SELECT * FROM provider_repositories"
   ```
3. Fix data issues with SQL commands or by resyncing repositories

### GitHub Integration Issues

#### Webhook Authentication Failures

**Symptoms**: GitHub webhook requests are rejected with 401 errors.

**Possible Causes**:

- Incorrect webhook secret
- Misconfigured GitHub App

**Solutions**:

1. Verify the GITHUB_WEBHOOK_SECRET environment variable
2. Check the GitHub App configuration
3. Regenerate the webhook secret if necessary

#### API Rate Limiting

**Symptoms**: GitHub API requests fail with 403 errors mentioning rate limits.

**Possible Causes**:

- Too many API requests
- Inefficient API usage

**Solutions**:

1. Implement conditional requests with ETags
2. Use webhooks instead of polling where possible
3. Optimize API usage patterns
4. Consider using a GitHub App with higher rate limits

#### Authentication Issues for Private Repositories

**Symptoms**: Unable to access private repository content.

**Possible Causes**:

- Missing or expired tokens
- Insufficient permissions

**Solutions**:

1. Verify the GitHub App installation has access to the repositories
2. Check token expiration and refresh mechanisms
3. Ensure proper scopes are requested during OAuth flow

### Queue Processing Issues

#### Jobs Not Being Processed

**Symptoms**: Repository updates are not being processed.

**Possible Causes**:

- Queue consumer not running
- Errors in queue processing code

**Solutions**:

1. Check the queue status in the Cloudflare dashboard
2. Verify queue bindings in wrangler.toml
3. Check for errors in the worker logs

#### Dead Letter Queue Filling Up

**Symptoms**: Many failed jobs in the dead letter queue.

**Possible Causes**:

- Persistent errors in job processing
- Invalid job data

**Solutions**:

1. Inspect the dead letter queue contents
2. Fix the underlying issues causing job failures
3. Implement better validation for job data

## Performance Issues

### Worker CPU Time Limits

**Symptoms**: Worker execution times out with CPU time limit errors.

**Possible Causes**:

- Processing large repositories without proper chunking
- Inefficient code

**Solutions**:

1. Implement proper chunking and yielding
2. Optimize code for performance
3. Use streaming for large files

### Memory Usage Issues

**Symptoms**: Worker crashes with out-of-memory errors.

**Possible Causes**:

- Loading too much data into memory
- Memory leaks

**Solutions**:

1. Use streaming instead of loading entire files
2. Process data in smaller chunks
3. Optimize memory usage in critical paths

## Getting Additional Help

If you're still experiencing issues after trying the solutions in this guide:

1. Check the Cloudflare Workers documentation
2. Review the GitHub API documentation
3. Examine the worker logs in the Cloudflare dashboard
4. Reach out to the development team with detailed information about the issue
