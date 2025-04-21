# Deployment Guide

This guide provides comprehensive instructions for deploying the Dome project to various environments. It covers deployment workflows, environment configuration, monitoring, and troubleshooting.

## 1. Deployment Overview

The Dome project follows a structured deployment process that ensures reliability, consistency, and traceability across all environments.

### 1.1 Deployment Environments

The project supports the following deployment environments:

| Environment | Purpose | Access |
|-------------|---------|--------|
| Development | For development and testing | Developers |
| Staging | For pre-production testing | Developers, QA |
| Production | For live, user-facing services | End users |

### 1.2 Deployment Workflow

The general deployment workflow is as follows:

1. **Code Changes**: Developers make changes in feature branches
2. **Pull Request**: Changes are submitted via pull request
3. **CI Checks**: Automated tests and checks run on the pull request
4. **Code Review**: Changes are reviewed by team members
5. **Merge**: Approved changes are merged to the main branch
6. **CI/CD Pipeline**: Automated deployment to the appropriate environment
7. **Verification**: Deployment is verified through automated and manual checks
8. **Monitoring**: Deployed services are monitored for issues

## 2. Deployment Prerequisites

Before deploying, ensure you have:

1. **Cloudflare Account**: Access to the Cloudflare account with appropriate permissions
2. **Wrangler CLI**: The latest version of Wrangler CLI installed
3. **Project Access**: Access to the project repository
4. **Environment Variables**: Access to the necessary environment variables and secrets
5. **Deployment Permissions**: Appropriate permissions to deploy to the target environment

## 3. Deployment Tools

### 3.1 Wrangler CLI

The primary tool for deploying Cloudflare Workers is the Wrangler CLI:

```bash
# Install Wrangler globally
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Check Wrangler version
wrangler --version
```

### 3.2 Just Command Runner

The project uses the `just` command runner to simplify deployment commands:

```bash
# Install just
# On macOS
brew install just

# On Linux
# Download from https://github.com/casey/just/releases

# On Windows
# Download from https://github.com/casey/just/releases
```

### 3.3 GitHub Actions

The project uses GitHub Actions for CI/CD. The workflow configurations are located in the `.github/workflows` directory.

## 4. Deployment Configuration

### 4.1 Wrangler Configuration

Each service has its own `wrangler.toml` file that defines its deployment configuration:

```toml
# Example wrangler.toml for a service
name = "service-name"
main = "src/index.ts"
compatibility_date = "2023-10-30"

# Environment-specific configuration
[env.production]
name = "service-name"
# Production-specific settings

[env.staging]
name = "service-name-staging"
# Staging-specific settings

[env.development]
name = "service-name-dev"
# Development-specific settings
```

### 4.2 Environment Variables

Environment variables are managed through:

1. **Wrangler Secrets**: For sensitive information
2. **Environment Variables in wrangler.toml**: For non-sensitive configuration
3. **GitHub Secrets**: For CI/CD pipeline configuration

To set a secret for a specific environment:

```bash
wrangler secret put SECRET_NAME --env production
```

### 4.3 Service Bindings

Service bindings are configured in the `wrangler.toml` file:

```toml
# Service bindings
[[services]]
binding = "CONSTELLATION"
service = "constellation"
environment = "production"

[[services]]
binding = "SILO"
service = "silo"
environment = "production"
```

### 4.4 Resource Bindings

Resource bindings (D1, R2, Vectorize, etc.) are configured in the `wrangler.toml` file:

```toml
# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "database-name"
database_id = "database-id"

# R2 Bucket
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "bucket-name"

# Vectorize Index
vectorize_binding = "VECTORIZE"
```

## 5. Deployment Process

### 5.1 Manual Deployment

#### 5.1.1 Deploying a Single Service

To deploy a single service to production:

```bash
just deploy <service-name>
```

For example, to deploy the Dome API service:

```bash
just deploy dome-api
```

#### 5.1.2 Deploying to a Specific Environment

To deploy a service to a specific environment:

```bash
just deploy-env <service-name> <environment>
```

For example, to deploy the Silo service to staging:

```bash
just deploy-env silo staging
```

#### 5.1.3 Deploying All Services

To deploy all services:

```bash
just deploy
```

### 5.2 Automated Deployment

The project uses GitHub Actions for automated deployment:

1. **Push to Main**: Merging to the main branch triggers deployment to the development environment
2. **Release Creation**: Creating a release triggers deployment to the staging environment
3. **Release Publication**: Publishing a release triggers deployment to the production environment

The deployment workflows are defined in the `.github/workflows` directory.

### 5.3 Database Migrations

Database migrations are applied as part of the deployment process:

```bash
# Apply migrations to development
just db-migrate-dev

# Apply migrations to staging
just db-migrate-staging

# Apply migrations to production
just db-migrate-prod
```

### 5.4 Deployment Verification

After deployment, verify that the services are running correctly:

1. **Health Checks**: Verify that health check endpoints return 200 OK
2. **Smoke Tests**: Run basic functionality tests
3. **Logs**: Check logs for any errors or warnings
4. **Metrics**: Verify that metrics are being reported correctly

## 6. Deployment Strategies

### 6.1 Blue-Green Deployment

For critical services, consider using a blue-green deployment strategy:

1. **Deploy to Staging**: Deploy the new version to staging
2. **Verify**: Thoroughly test the new version in staging
3. **Deploy to Blue**: Deploy the new version to the blue environment
4. **Verify**: Verify the new version in the blue environment
5. **Switch Traffic**: Gradually shift traffic from green to blue
6. **Monitor**: Monitor for any issues
7. **Complete Switch**: Complete the traffic switch when confident

### 6.2 Canary Deployment

For gradual rollouts, consider using a canary deployment strategy:

1. **Deploy Canary**: Deploy the new version to a small subset of users
2. **Monitor**: Monitor for any issues
3. **Gradual Rollout**: Gradually increase the percentage of users on the new version
4. **Complete Rollout**: Complete the rollout when confident

### 6.3 Rollback Procedure

If issues are detected after deployment:

1. **Identify Issue**: Determine the cause of the issue
2. **Decision**: Decide whether to fix forward or roll back
3. **Rollback**: If rolling back, deploy the previous version
4. **Verify**: Verify that the rollback resolved the issue
5. **Root Cause Analysis**: Determine the root cause of the issue
6. **Fix**: Implement a fix for the issue
7. **Deploy**: Deploy the fixed version

## 7. Environment-Specific Configuration

### 7.1 Development Environment

The development environment is used for development and testing:

- **Naming Convention**: Service names have a `-dev` suffix
- **Resource Isolation**: Each service has its own resources
- **Logging**: Verbose logging is enabled
- **Debugging**: Debugging features are enabled

### 7.2 Staging Environment

The staging environment is used for pre-production testing:

- **Naming Convention**: Service names have a `-staging` suffix
- **Configuration**: Configuration matches production as closely as possible
- **Data**: Test data is used, not production data
- **Access**: Limited to internal users

### 7.3 Production Environment

The production environment is used for live, user-facing services:

- **Naming Convention**: Service names have no suffix
- **Configuration**: Optimized for performance and reliability
- **Data**: Real user data
- **Access**: Available to end users
- **Monitoring**: Comprehensive monitoring and alerting

## 8. Monitoring and Observability

### 8.1 Logging

All services use structured logging:

```typescript
logger.info({
  event: 'request_processed',
  userId: request.userId,
  duration: performance.now() - startTime,
}, 'Request processed successfully');
```

Logs are collected and can be viewed in the Cloudflare dashboard or exported to external logging systems.

### 8.2 Metrics

Key metrics are collected for all services:

```typescript
metrics.counter('requests.count', 1);
metrics.timing('request.duration_ms', performance.now() - startTime);
```

Metrics are available in the Cloudflare dashboard and can be exported to external monitoring systems.

### 8.3 Alerts

Alerts are configured for critical metrics:

- **Error Rate**: Alert if error rate exceeds threshold
- **Latency**: Alert if latency exceeds threshold
- **Queue Depth**: Alert if queue depth exceeds threshold
- **Resource Usage**: Alert if resource usage exceeds threshold

### 8.4 Dashboards

Monitoring dashboards are available in the Cloudflare dashboard and provide visibility into:

- **Service Health**: Overall health of each service
- **Performance**: Response times, throughput, etc.
- **Errors**: Error rates and types
- **Resource Usage**: CPU, memory, etc.

## 9. Troubleshooting Deployment Issues

### 9.1 Common Deployment Issues

#### 9.1.1 Wrangler Authentication Issues

**Symptoms**:
- `Error: Authentication error`
- `Error: You must be logged in to use this command`

**Solutions**:
- Run `wrangler login` to authenticate
- Check that you have the correct permissions in Cloudflare

#### 9.1.2 Resource Binding Issues

**Symptoms**:
- `Error: Could not find binding`
- `Error: Resource not found`

**Solutions**:
- Verify that the resource exists in the Cloudflare dashboard
- Check that the resource ID is correct in `wrangler.toml`
- Ensure you have the correct permissions for the resource

#### 9.1.3 Environment Variable Issues

**Symptoms**:
- `Error: Missing required environment variable`
- `Error: Invalid configuration`

**Solutions**:
- Check that all required environment variables are set
- Verify that environment variables have the correct values
- Ensure secrets are set for the correct environment

#### 9.1.4 Service Binding Issues

**Symptoms**:
- `Error: Service binding failed`
- `Error: Service not found`

**Solutions**:
- Verify that the service exists and is deployed
- Check that the service name is correct in `wrangler.toml`
- Ensure you have the correct permissions for the service

### 9.2 Debugging Deployment

#### 9.2.1 Verbose Deployment

To get more information during deployment:

```bash
wrangler deploy --verbose
```

#### 9.2.2 Checking Deployment Status

To check the status of a deployed service:

```bash
wrangler status <service-name>
```

#### 9.2.3 Viewing Logs

To view logs for a deployed service:

```bash
wrangler tail <service-name>
```

#### 9.2.4 Checking Resource Status

To check the status of resources:

```bash
# D1 Database
wrangler d1 list

# R2 Bucket
wrangler r2 bucket list

# Vectorize Index
wrangler vectorize list
```

## 10. Deployment Best Practices

### 10.1 General Best Practices

1. **Test Before Deploying**: Always test changes thoroughly before deploying
2. **Use Version Control**: Always deploy from version control
3. **Automate Deployments**: Use CI/CD for consistent deployments
4. **Monitor Deployments**: Monitor services after deployment
5. **Document Changes**: Document all changes and deployments
6. **Use Feature Flags**: Use feature flags for risky changes
7. **Plan for Rollbacks**: Always have a rollback plan
8. **Deploy During Low-Traffic Periods**: When possible, deploy during low-traffic periods

### 10.2 Cloudflare Workers Best Practices

1. **Optimize for Edge Computing**: Be mindful of the constraints of Cloudflare Workers
2. **Use Appropriate Resource Bindings**: Choose the right resources for your needs
3. **Minimize Cold Starts**: Design services to minimize cold start impact
4. **Handle Errors Gracefully**: Implement robust error handling
5. **Use Appropriate Caching**: Leverage caching for performance
6. **Monitor Resource Usage**: Keep an eye on CPU and memory usage
7. **Use Service Bindings**: Use service bindings for inter-service communication
8. **Implement Circuit Breakers**: Protect against cascading failures

## 11. Continuous Improvement

### 11.1 Deployment Metrics

Track key deployment metrics:

- **Deployment Frequency**: How often deployments occur
- **Lead Time**: Time from code commit to deployment
- **Change Failure Rate**: Percentage of deployments that cause issues
- **Mean Time to Recovery**: Time to recover from deployment issues

### 11.2 Post-Deployment Reviews

After significant deployments, conduct a post-deployment review:

1. **What Went Well**: Identify successful aspects of the deployment
2. **What Could Be Improved**: Identify areas for improvement
3. **Action Items**: Define specific actions to improve future deployments

### 11.3 Deployment Automation

Continuously improve deployment automation:

1. **Identify Manual Steps**: Identify steps that are currently manual
2. **Automate Where Possible**: Automate manual steps where possible
3. **Improve Testing**: Enhance automated testing
4. **Enhance Monitoring**: Improve deployment monitoring

## 12. Conclusion

Effective deployment is critical to the success of the Dome project. By following the guidelines in this document, you can ensure reliable, consistent, and traceable deployments across all environments.

Remember that deployment is not just about getting code into production—it's about delivering value to users safely and efficiently. Invest time in improving your deployment process, and it will pay dividends in terms of reliability, velocity, and developer satisfaction.