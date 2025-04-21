# Pulumi Maintenance Guide

## Table of Contents

- [Introduction](#introduction)
- [Updating Infrastructure Code](#updating-infrastructure-code)
  - [Updating Dependencies](#updating-dependencies)
  - [Updating Resource Configurations](#updating-resource-configurations)
  - [Updating Environment Configurations](#updating-environment-configurations)
  - [Applying Updates](#applying-updates)
- [Adding New Resources](#adding-new-resources)
  - [Adding D1 Databases](#adding-d1-databases)
  - [Adding R2 Buckets](#adding-r2-buckets)
  - [Adding Vectorize Indexes](#adding-vectorize-indexes)
  - [Adding Queues](#adding-queues)
  - [Adding Workers](#adding-workers)
  - [Adding Service Bindings](#adding-service-bindings)
- [Pulumi State Management](#pulumi-state-management)
  - [Understanding Pulumi State](#understanding-pulumi-state)
  - [Viewing State](#viewing-state)
  - [Refreshing State](#refreshing-state)
  - [Importing Resources](#importing-resources)
  - [Exporting State](#exporting-state)
  - [Recovering from State Issues](#recovering-from-state-issues)
- [Managing Secrets and Sensitive Information](#managing-secrets-and-sensitive-information)
  - [Using Pulumi Secrets](#using-pulumi-secrets)
  - [Environment Variables](#environment-variables)
  - [Secret Rotation](#secret-rotation)
  - [Accessing Secrets](#accessing-secrets)
- [Monitoring and Alerting](#monitoring-and-alerting)
  - [Drift Detection](#drift-detection)
  - [Deployment Monitoring](#deployment-monitoring)
  - [Resource Monitoring](#resource-monitoring)
- [Backup and Recovery](#backup-and-recovery)
  - [State Backup](#state-backup)
  - [Recovery Procedures](#recovery-procedures)
- [Troubleshooting](#troubleshooting)
  - [Common Issues](#common-issues)
  - [Debugging Techniques](#debugging-techniques)
  - [Getting Help](#getting-help)

## Introduction

This guide provides comprehensive instructions for maintaining the Dome project's Pulumi infrastructure. It covers how to update the infrastructure code, add new resources, manage Pulumi state, handle secrets and sensitive information, and troubleshoot common issues.

The maintenance of infrastructure as code requires a disciplined approach to ensure consistency, reliability, and security. This guide aims to establish best practices and procedures for ongoing maintenance of the Pulumi-managed infrastructure.

## Updating Infrastructure Code

### Updating Dependencies

Regularly updating dependencies is important for security and to access new features. Follow these steps to update dependencies:

1. Check for outdated dependencies:
   ```bash
   cd infra
   pnpm outdated
   ```

2. Update dependencies:
   ```bash
   # Update all dependencies
   pnpm update

   # Update specific dependencies
   pnpm update @pulumi/cloudflare
   ```

3. Review the changes:
   ```bash
   git diff package.json
   ```

4. Test the updates:
   ```bash
   pnpm install
   pnpm build
   just pulumi-preview dev
   ```

5. Commit the changes:
   ```bash
   git add package.json pnpm-lock.yaml
   git commit -m "chore: update infrastructure dependencies"
   ```

### Updating Resource Configurations

To update the configuration of existing resources:

1. Locate the resource definition in the appropriate file in `src/resources/`
2. Modify the configuration as needed
3. Preview the changes:
   ```bash
   just pulumi-preview dev
   ```
4. Apply the changes:
   ```bash
   just pulumi-up dev
   ```

Example of updating a worker's configuration:

```typescript
// In src/resources/workers.ts
// Update the dome-api worker configuration
workers.domeApi = createWorker(
  {
    name: 'dome-api',
    mainModule: 'services/dome-api/src/index.ts',
    compatibilityDate: '2025-04-15',
    compatibilityFlags: ['nodejs_als', 'new_flag'], // Added a new flag
    bindings: [
      { type: 'ai', name: 'AI' },
      { type: 'service', name: 'CONSTELLATION', service: 'constellation' },
      { type: 'service', name: 'SILO', service: 'silo' },
    ],
    vars: {
      VERSION: '0.2.0', // Updated version
      LOG_LEVEL: 'debug',
    },
  },
  d1Databases,
  r2Buckets,
  vectorizeIndexes,
  queues
);
```

### Updating Environment Configurations

To update environment-specific configurations:

1. Edit the appropriate stack configuration file:
   - `Pulumi.dev.yaml` for development
   - `Pulumi.staging.yaml` for staging
   - `Pulumi.prod.yaml` for production

2. Update the configuration values:
   ```yaml
   # Example: Pulumi.dev.yaml
   config:
     cloudflare:accountId: ${CLOUDFLARE_ACCOUNT_ID}
     dome-infrastructure:environment: dev
     dome-infrastructure:logLevel: trace  # Changed from debug to trace
   ```

3. Preview the changes:
   ```bash
   just pulumi-preview dev
   ```

4. Apply the changes:
   ```bash
   just pulumi-up dev
   ```

Alternatively, use the Pulumi CLI to update configuration values:

```bash
pulumi config set dome-infrastructure:logLevel trace --stack dev
```

### Applying Updates

When applying updates to the infrastructure, follow these steps:

1. Create a feature branch:
   ```bash
   git checkout -b feature/update-infrastructure
   ```

2. Make the necessary changes to the infrastructure code

3. Preview the changes for all environments:
   ```bash
   just preview-all
   ```

4. Review the changes carefully, paying attention to:
   - Resources being created
   - Resources being updated
   - Resources being deleted
   - Any replacement operations (which may cause downtime)

5. Apply the changes to the development environment:
   ```bash
   just pulumi-up dev
   ```

6. Test the changes in the development environment

7. Apply the changes to the staging environment:
   ```bash
   just pulumi-up staging
   ```

8. Test the changes in the staging environment

9. Apply the changes to the production environment:
   ```bash
   just pulumi-up prod
   ```

10. Verify the changes in the production environment

11. Commit and push the changes:
    ```bash
    git add .
    git commit -m "feat: update infrastructure"
    git push origin feature/update-infrastructure
    ```

12. Create a pull request and request a review

## Adding New Resources

### Adding D1 Databases

To add a new D1 database:

1. Open `src/resources/databases.ts`
2. Add the new database definition:
   ```typescript
   // Add a new database
   databases.newDatabase = new cloudflare.D1Database("new-database", {
     name: resourceName("new-database"),
   });
   ```
3. Preview and apply the changes:
   ```bash
   just pulumi-preview dev
   just pulumi-up dev
   ```
4. Update any workers that need to use the new database:
   ```typescript
   // In src/resources/workers.ts
   // Add the database binding to a worker
   bindings: [
     // Existing bindings...
     { type: 'd1Database', name: 'NEW_DB', databaseId: 'newDatabase' },
   ],
   ```

### Adding R2 Buckets

To add a new R2 bucket:

1. Open `src/resources/storage.ts`
2. Add the new bucket definition:
   ```typescript
   // Add a new bucket
   buckets.newBucket = new cloudflare.R2Bucket("new-bucket", {
     name: resourceName("new-bucket"),
   });
   ```
3. Preview and apply the changes:
   ```bash
   just pulumi-preview dev
   just pulumi-up dev
   ```
4. Update any workers that need to use the new bucket:
   ```typescript
   // In src/resources/workers.ts
   // Add the bucket binding to a worker
   bindings: [
     // Existing bindings...
     { type: 'r2Bucket', name: 'NEW_BUCKET', bucketName: 'newBucket' },
   ],
   ```

### Adding Vectorize Indexes

To add a new Vectorize index:

1. Open `src/resources/vectorize.ts`
2. Add the new index definition:
   ```typescript
   // Add a new index
   indexes.newIndex = new cloudflare.VectorizeIndex("new-index", {
     name: resourceName("new-index"),
     dimensions: 1536,
     metric: "cosine",
   });
   ```
3. Preview and apply the changes:
   ```bash
   just pulumi-preview dev
   just pulumi-up dev
   ```
4. Update any workers that need to use the new index:
   ```typescript
   // In src/resources/workers.ts
   // Add the index binding to a worker
   bindings: [
     // Existing bindings...
     { type: 'vectorizeIndex', name: 'NEW_INDEX', indexName: 'newIndex' },
   ],
   ```

### Adding Queues

To add a new queue:

1. Open `src/resources/queues.ts`
2. Add the new queue definition:
   ```typescript
   // Add a new queue
   queues.newQueue = new cloudflare.WorkersQueue("new-queue", {
     name: resourceName("new-queue"),
   });
   ```
3. Preview and apply the changes:
   ```bash
   just pulumi-preview dev
   just pulumi-up dev
   ```
4. Update any workers that need to use the new queue:
   ```typescript
   // In src/resources/workers.ts
   // Add the queue binding to a worker
   bindings: [
     // Existing bindings...
     { type: 'queue', name: 'NEW_QUEUE', queueName: 'newQueue' },
   ],
   ```

### Adding Workers

To add a new worker:

1. Open `src/resources/workers.ts`
2. Add the new worker definition:
   ```typescript
   // Add a new worker
   workers.newWorker = createWorker(
     {
       name: 'new-worker',
       mainModule: 'services/new-worker/src/index.ts',
       compatibilityDate: '2025-04-15',
       compatibilityFlags: ['nodejs_als'],
       bindings: [
         { type: 'd1Database', name: 'DB', databaseId: 'domeMeta' },
         { type: 'queue', name: 'EVENTS', queueName: 'domeEvents' },
       ],
       vars: {
         VERSION: '0.1.0',
         LOG_LEVEL: 'debug',
       },
     },
     d1Databases,
     r2Buckets,
     vectorizeIndexes,
     queues
   );
   ```
3. Preview and apply the changes:
   ```bash
   just pulumi-preview dev
   just pulumi-up dev
   ```

### Adding Service Bindings

To add a new service binding:

1. Open `src/resources/bindings.ts`
2. Add the new binding definition:
   ```typescript
   // Add a new service binding
   bindings.push(new cloudflare.ServiceBinding("new-worker-to-silo", {
     service: workers.silo.name,
     environment: environment,
     binding: "SILO",
     script: workers.newWorker.name,
   }));
   ```
3. Preview and apply the changes:
   ```bash
   just pulumi-preview dev
   just pulumi-up dev
   ```

## Pulumi State Management

### Understanding Pulumi State

Pulumi state is a snapshot of the resources managed by Pulumi. It includes:
- Resource definitions
- Resource properties
- Resource dependencies
- Metadata about the deployment

The state is stored in the Pulumi Service by default, which provides:
- Secure storage
- Versioning
- Collaboration features
- Audit history

### Viewing State

To view the current state:

```bash
cd infra
pulumi stack select dev
pulumi stack
```

To view detailed state information:

```bash
pulumi stack export > state.json
```

This exports the state to a JSON file that you can inspect.

### Refreshing State

If the actual infrastructure has changed outside of Pulumi, you can refresh the state to match reality:

```bash
cd infra
pulumi stack select dev
pulumi refresh
```

This will update the Pulumi state to match the actual infrastructure without making any changes to the resources.

### Importing Resources

To import existing resources into Pulumi state:

1. Define the resource in your Pulumi code:
   ```typescript
   // Define the resource without creating it
   const database = new cloudflare.D1Database("existing-database", {
     name: "existing-database",
   });
   ```

2. Import the resource:
   ```bash
   cd infra
   pulumi stack select dev
   pulumi import cloudflare:index/d1Database:D1Database existing-database <database-id>
   ```

3. Update your Pulumi code to match the imported resource:
   ```typescript
   // Update the resource definition with the correct properties
   const database = new cloudflare.D1Database("existing-database", {
     name: "existing-database",
     // Add any other properties from the imported resource
   });
   ```

### Exporting State

To export the Pulumi state:

```bash
cd infra
pulumi stack select dev
pulumi stack export > dev-state.json
```

This is useful for:
- Backup purposes
- Debugging
- Migrating to a different Pulumi backend

### Recovering from State Issues

If you encounter state issues, you can try the following approaches:

1. **Refresh the state**:
   ```bash
   pulumi refresh
   ```

2. **Fix specific resources**:
   ```bash
   pulumi import <resource-type> <resource-name> <resource-id>
   ```

3. **Reset the state** (use with caution):
   ```bash
   # Export the current state as a backup
   pulumi stack export > backup.json
   
   # Remove the stack
   pulumi stack rm dev --force
   
   # Recreate the stack
   pulumi stack init dev
   
   # Import resources
   # Run import commands for each resource
   ```

4. **Restore from backup**:
   ```bash
   pulumi stack import < backup.json
   ```

## Managing Secrets and Sensitive Information

### Using Pulumi Secrets

Pulumi provides built-in secret management. To use it:

1. Store a secret:
   ```bash
   pulumi config set --secret apiKey "your-secret-api-key"
   ```

2. Access the secret in your code:
   ```typescript
   const config = new pulumi.Config();
   const apiKey = config.requireSecret("apiKey");
   ```

3. Use the secret in a resource:
   ```typescript
   const worker = new cloudflare.WorkerScript("api-worker", {
     // ...
     secretTextBindings: {
       API_KEY: apiKey,
     },
   });
   ```

### Environment Variables

For sensitive information that should not be stored in the Pulumi state, use environment variables:

1. Set environment variables:
   ```bash
   export CLOUDFLARE_API_TOKEN=your-api-token
   export CLOUDFLARE_ACCOUNT_ID=your-account-id
   ```

2. Reference environment variables in your code:
   ```typescript
   // These are automatically used by the Cloudflare provider
   // No need to explicitly reference them in your code
   ```

3. For custom environment variables, use:
   ```typescript
   const customSecret = process.env.CUSTOM_SECRET;
   ```

### Secret Rotation

To rotate secrets:

1. Update the secret in the appropriate system (e.g., Cloudflare dashboard)
2. Update the secret in Pulumi:
   ```bash
   pulumi config set --secret apiKey "new-secret-api-key"
   ```
3. Deploy the changes:
   ```bash
   just pulumi-up dev
   ```

### Accessing Secrets

To access secrets in your code:

```typescript
// For Pulumi secrets
const config = new pulumi.Config();
const apiKey = config.requireSecret("apiKey");

// For environment variables
const envSecret = process.env.SECRET_VALUE;
```

## Monitoring and Alerting

### Drift Detection

Drift occurs when the actual infrastructure differs from the Pulumi state. To detect drift:

1. Run a refresh operation:
   ```bash
   pulumi refresh
   ```

2. If changes are detected, Pulumi will show the differences

3. Decide whether to:
   - Update the Pulumi state to match reality
   - Update the infrastructure to match the Pulumi state

4. Consider setting up automated drift detection:
   ```bash
   # Create a script to run periodically
   #!/bin/bash
   cd /path/to/infra
   pulumi stack select dev
   pulumi refresh --expect-no-changes || echo "Drift detected in dev stack" | mail -s "Pulumi Drift Alert" admin@example.com
   ```

### Deployment Monitoring

To monitor deployments:

1. Use Pulumi's built-in history:
   ```bash
   pulumi stack history
   ```

2. Set up notifications for deployments:
   ```bash
   # In your CI/CD pipeline
   pulumi up --yes && curl -X POST "https://api.example.com/notify?message=Deployment%20successful"
   ```

3. Monitor deployment logs:
   ```bash
   pulumi up --verbose
   ```

### Resource Monitoring

To monitor Cloudflare resources:

1. Use Cloudflare's built-in monitoring tools
2. Set up custom monitoring using Cloudflare Analytics
3. Integrate with external monitoring systems

## Backup and Recovery

### State Backup

Regularly back up your Pulumi state:

1. Set up automated backups:
   ```bash
   # Create a backup script
   #!/bin/bash
   cd /path/to/infra
   pulumi stack select dev
   pulumi stack export > backups/dev-$(date +%Y%m%d).json
   ```

2. Store backups securely:
   - Use encrypted storage
   - Implement retention policies
   - Test backup restoration periodically

### Recovery Procedures

To recover from a disaster:

1. Restore the Pulumi state:
   ```bash
   cd /path/to/infra
   pulumi stack select dev
   pulumi stack import < backups/dev-20250415.json
   ```

2. Verify the state:
   ```bash
   pulumi preview
   ```

3. Reconcile any differences:
   ```bash
   pulumi refresh
   ```

4. Apply any necessary changes:
   ```bash
   pulumi up
   ```

## Troubleshooting

### Common Issues

#### Issue: Resource Creation Failure

**Symptoms**:
- Pulumi reports a resource creation failure
- Error message indicates a problem with the resource configuration

**Possible Causes**:
- Invalid resource configuration
- API token permissions
- Resource name conflicts
- Resource limits reached

**Resolution**:
1. Check the error message for specific details
2. Verify the resource configuration
3. Check API token permissions
4. Verify resource name uniqueness
5. Check resource limits

#### Issue: State Inconsistency

**Symptoms**:
- Pulumi reports differences between the expected and actual state
- Resources have been modified outside of Pulumi

**Possible Causes**:
- Manual changes to resources
- Changes made through the Cloudflare dashboard
- Changes made by other tools

**Resolution**:
1. Run `pulumi refresh` to update the state
2. Review the differences
3. Decide whether to accept the changes or revert to the expected state

#### Issue: Dependency Resolution Failure

**Symptoms**:
- Pulumi reports a dependency resolution failure
- Error message indicates a problem with resource dependencies

**Possible Causes**:
- Circular dependencies
- Missing dependencies
- Incorrect dependency order

**Resolution**:
1. Check the dependency graph
2. Verify all dependencies exist
3. Correct the dependency order

### Debugging Techniques

1. **Enable verbose logging**:
   ```bash
   pulumi up --verbose
   ```

2. **Examine the Pulumi logs**:
   ```bash
   pulumi logs
   ```

3. **Check the Cloudflare API logs** in the Cloudflare dashboard

4. **Use the Pulumi Console** to view detailed information about resources and deployments

5. **Export and examine the state**:
   ```bash
   pulumi stack export > state.json
   ```

### Getting Help

If you encounter issues that you cannot resolve:

1. **Check the Pulumi documentation**:
   - [Pulumi Docs](https://www.pulumi.com/docs/)
   - [Cloudflare Provider Docs](https://www.pulumi.com/registry/packages/cloudflare/)

2. **Search the Pulumi Community Forum**:
   - [Pulumi Community](https://www.pulumi.com/community/)

3. **Open an issue in the project repository**:
   - Provide detailed information about the issue
   - Include error messages and logs
   - Describe the steps to reproduce the issue

4. **Contact the infrastructure team**:
   - Reach out to the team responsible for the infrastructure
   - Provide all relevant information about the issue