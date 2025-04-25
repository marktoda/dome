# Deployment Guide

This guide provides detailed instructions for deploying the Chat RAG Graph solution to production environments. It covers deployment prerequisites, procedures, validation, and post-deployment tasks.

## Deployment Architecture

The Chat RAG Graph solution is deployed as a set of Cloudflare Workers, leveraging the edge computing model for low-latency, globally distributed processing. The deployment architecture includes:

- **Chat Orchestrator Worker**: The core service that implements the graph-based processing
- **Vectorize Index**: Stores document embeddings for semantic search
- **D1 Database**: Stores state checkpoints and other persistent data
- **KV Namespace**: Stores configuration and other key-value data
- **R2 Bucket**: Stores large documents and binary assets

## Deployment Prerequisites

Before deploying the Chat RAG Graph solution, ensure you have:

1. **Cloudflare Account**: An account with access to Workers, D1, KV, R2, and Vectorize
2. **Wrangler CLI**: Installed and configured with your Cloudflare account
3. **Node.js**: Version 18 or later
4. **pnpm**: Version 8 or later
5. **Git**: For version control
6. **CI/CD Pipeline**: (Optional) For automated deployments

## Environment Setup

The Chat RAG Graph solution supports multiple deployment environments:

- **Development**: For development and testing
- **Staging**: For pre-production validation
- **Production**: For live usage

Each environment requires its own set of Cloudflare resources:

### 1. Create D1 Database

```bash
# Create D1 database for each environment
wrangler d1 create chat-orchestrator-dev
wrangler d1 create chat-orchestrator-staging
wrangler d1 create chat-orchestrator-prod
```

Note the database IDs for each environment.

### 2. Create KV Namespace

```bash
# Create KV namespace for each environment
wrangler kv:namespace create chat-orchestrator-config-dev
wrangler kv:namespace create chat-orchestrator-config-staging
wrangler kv:namespace create chat-orchestrator-config-prod
```

Note the namespace IDs for each environment.

### 3. Create R2 Bucket

```bash
# Create R2 bucket for each environment
wrangler r2 bucket create chat-orchestrator-assets-dev
wrangler r2 bucket create chat-orchestrator-assets-staging
wrangler r2 bucket create chat-orchestrator-assets-prod
```

### 4. Create Vectorize Index

```bash
# Create Vectorize index for each environment
wrangler vectorize create chat-orchestrator-index-dev --dimensions 768 --metric cosine
wrangler vectorize create chat-orchestrator-index-staging --dimensions 768 --metric cosine
wrangler vectorize create chat-orchestrator-index-prod --dimensions 768 --metric cosine
```

Note the index IDs for each environment.

## Configuration

### 1. Environment Variables

Create environment-specific `.dev.vars` files:

**Development (.dev.vars)**:
```
DOME_API_URL=https://api-dev.dome.cloud
DOME_API_KEY=dev-api-key
JWT_SECRET=dev-jwt-secret
LOG_LEVEL=debug
```

**Staging (set in Cloudflare dashboard)**:
```
DOME_API_URL=https://api-staging.dome.cloud
DOME_API_KEY=staging-api-key
JWT_SECRET=staging-jwt-secret
LOG_LEVEL=info
```

**Production (set in Cloudflare dashboard)**:
```
DOME_API_URL=https://api.dome.cloud
DOME_API_KEY=prod-api-key
JWT_SECRET=prod-jwt-secret
LOG_LEVEL=warn
```

### 2. Wrangler Configuration

Update `wrangler.toml` with environment-specific configurations:

```toml
name = "chat-orchestrator"
main = "src/index.ts"
compatibility_date = "2025-04-15"

# Development environment
[env.dev]
workers_dev = true
[[env.dev.d1_databases]]
binding = "D1"
database_name = "chat-orchestrator-dev"
database_id = "your-dev-database-id"

[[env.dev.kv_namespaces]]
binding = "KV"
id = "your-dev-kv-namespace-id"

[[env.dev.r2_buckets]]
binding = "R2"
bucket_name = "chat-orchestrator-assets-dev"

[[env.dev.vectorize_indexes]]
binding = "VECTORIZE"
index_name = "chat-orchestrator-index-dev"

# Staging environment
[env.staging]
workers_dev = false
route = "chat-orchestrator-staging.dome.cloud/*"
[[env.staging.d1_databases]]
binding = "D1"
database_name = "chat-orchestrator-staging"
database_id = "your-staging-database-id"

[[env.staging.kv_namespaces]]
binding = "KV"
id = "your-staging-kv-namespace-id"

[[env.staging.r2_buckets]]
binding = "R2"
bucket_name = "chat-orchestrator-assets-staging"

[[env.staging.vectorize_indexes]]
binding = "VECTORIZE"
index_name = "chat-orchestrator-index-staging"

# Production environment
[env.prod]
workers_dev = false
route = "chat-orchestrator.dome.cloud/*"
[[env.prod.d1_databases]]
binding = "D1"
database_name = "chat-orchestrator-prod"
database_id = "your-prod-database-id"

[[env.prod.kv_namespaces]]
binding = "KV"
id = "your-prod-kv-namespace-id"

[[env.prod.r2_buckets]]
binding = "R2"
bucket_name = "chat-orchestrator-assets-prod"

[[env.prod.vectorize_indexes]]
binding = "VECTORIZE"
index_name = "chat-orchestrator-index-prod"
```

## Database Migrations

Before deployment, apply database migrations:

```bash
# Apply migrations to development
wrangler d1 execute chat-orchestrator-dev --local --file=./migrations/initial.sql

# Apply migrations to staging
wrangler d1 execute chat-orchestrator-staging --file=./migrations/initial.sql

# Apply migrations to production
wrangler d1 execute chat-orchestrator-prod --file=./migrations/initial.sql
```

## Deployment Procedures

### Manual Deployment

#### 1. Development Deployment

```bash
# Build the project
pnpm build

# Deploy to development
wrangler deploy --env dev
```

#### 2. Staging Deployment

```bash
# Build the project
pnpm build

# Deploy to staging
wrangler deploy --env staging
```

#### 3. Production Deployment

```bash
# Build the project
pnpm build

# Deploy to production
wrangler deploy --env prod
```

### Automated Deployment with GitHub Actions

Create a GitHub Actions workflow file (`.github/workflows/deploy.yml`):

```yaml
name: Deploy

on:
  push:
    branches:
      - main  # Deploy to staging on push to main
      - production  # Deploy to production on push to production

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: 18
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Build
        run: pnpm build
      
      - name: Deploy to staging
        if: github.ref == 'refs/heads/main'
        run: npx wrangler deploy --env staging
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      
      - name: Deploy to production
        if: github.ref == 'refs/heads/production'
        run: npx wrangler deploy --env prod
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

## Deployment Validation

After deployment, validate that the system is working correctly:

### 1. Health Check

```bash
# Check development
curl https://chat-orchestrator-dev.dome.cloud/api/health

# Check staging
curl https://chat-orchestrator-staging.dome.cloud/api/health

# Check production
curl https://chat-orchestrator.dome.cloud/api/health
```

Expected response:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "environment": "production"
}
```

### 2. Functional Test

```bash
# Test chat API
curl -X POST https://chat-orchestrator.dome.cloud/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-test-token" \
  -d '{
    "messages": [
      {"role": "user", "content": "What is the capital of France?"}
    ],
    "options": {
      "enhanceWithContext": true,
      "maxContextItems": 5,
      "includeSourceInfo": true
    }
  }'
```

### 3. Log Verification

Check the logs in the Cloudflare dashboard to ensure that the system is logging correctly.

### 4. Metrics Verification

Check the metrics dashboard to ensure that the system is reporting metrics correctly.

## Post-Deployment Tasks

### 1. Update Documentation

Update the deployment documentation with any changes to the deployment process.

### 2. Notify Stakeholders

Notify stakeholders that a new version has been deployed, including:

- Release notes
- New features
- Bug fixes
- Known issues

### 3. Monitor System

Monitor the system for any issues after deployment:

- Check logs for errors
- Monitor performance metrics
- Watch for any unusual behavior

### 4. Verify Integrations

Verify that all integrations are working correctly:

- External APIs
- Authentication systems
- Monitoring systems
- Alerting systems

## Rollback Procedures

If issues are detected after deployment, follow the [Rollback Procedures](./rollback.md) to revert to a previous version.

## Deployment Frequency

The recommended deployment frequency depends on the environment:

- **Development**: As needed for testing
- **Staging**: Daily or weekly, depending on development activity
- **Production**: Weekly or bi-weekly, after thorough testing in staging

## Deployment Best Practices

1. **Version Control**: Always deploy from version control, never from local changes.

2. **Environment Parity**: Maintain parity between environments to minimize environment-specific issues.

3. **Database Migrations**: Apply database migrations before deploying code changes.

4. **Automated Testing**: Run automated tests before deployment to catch issues early.

5. **Gradual Rollout**: Use gradual rollouts to minimize the impact of changes.

6. **Monitoring**: Monitor the system during and after deployment to detect issues.

7. **Rollback Plan**: Always have a rollback plan in case issues are detected.

8. **Documentation**: Keep deployment documentation up to date.

9. **Communication**: Communicate deployments to stakeholders.

10. **Post-Deployment Verification**: Verify that the system is working correctly after deployment.

## Deployment Checklist

Use this checklist for each deployment:

- [ ] Code changes are reviewed and approved
- [ ] Automated tests pass
- [ ] Database migrations are prepared
- [ ] Environment variables are configured
- [ ] Deployment plan is communicated to stakeholders
- [ ] Backup is created (if applicable)
- [ ] Database migrations are applied
- [ ] Code is deployed
- [ ] Health check passes
- [ ] Functional tests pass
- [ ] Logs are verified
- [ ] Metrics are verified
- [ ] Integrations are verified
- [ ] Documentation is updated
- [ ] Stakeholders are notified

## Conclusion

Following these deployment procedures will ensure that the Chat RAG Graph solution is deployed reliably and consistently across environments. For more information on operating the system, see the [Operations Documentation](./README.md).