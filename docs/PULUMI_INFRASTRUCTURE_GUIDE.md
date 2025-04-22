# Pulumi Infrastructure Guide

## Table of Contents

- [Introduction](#introduction)
- [Architecture Overview](#architecture-overview)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Initial Setup](#initial-setup)
  - [Authentication](#authentication)
- [Project Structure](#project-structure)
- [Resource Management](#resource-management)
  - [D1 Databases](#d1-databases)
  - [R2 Buckets](#r2-buckets)
  - [Vectorize Indexes](#vectorize-indexes)
  - [Queues](#queues)
  - [Workers](#workers)
  - [Service Bindings](#service-bindings)
- [Deployment Workflow](#deployment-workflow)
  - [Development Environment](#development-environment)
  - [Staging Environment](#staging-environment)
  - [Production Environment](#production-environment)
  - [Promotion Between Environments](#promotion-between-environments)
- [Common Operations](#common-operations)
  - [Adding New Resources](#adding-new-resources)
  - [Updating Existing Resources](#updating-existing-resources)
  - [Removing Resources](#removing-resources)
  - [Viewing Stack Outputs](#viewing-stack-outputs)
- [Troubleshooting](#troubleshooting)
  - [Common Deployment Issues](#common-deployment-issues)
  - [State Management Issues](#state-management-issues)
  - [Resource-Specific Issues](#resource-specific-issues)
  - [Dependency Resolution Problems](#dependency-resolution-problems)
- [Best Practices](#best-practices)
- [Reference](#reference)
  - [Justfile Commands](#justfile-commands)
  - [Environment Variables](#environment-variables)
  - [Pulumi CLI Commands](#pulumi-cli-commands)

## Introduction

This guide provides comprehensive documentation for the Dome project's infrastructure as code (IaC) implementation using Pulumi. It covers the architecture, deployment workflows, common operations, and troubleshooting guidance for managing Cloudflare resources through Pulumi.

The infrastructure code is designed to manage all Cloudflare resources required by the Dome project, including Workers, D1 databases, R2 buckets, Vectorize indexes, queues, and service bindings. The implementation follows a multi-environment approach with separate configurations for development, staging, and production environments.

## Architecture Overview

The Pulumi infrastructure is organized around the following key components:

1. **Core Resources**: Fundamental Cloudflare resources like D1 databases, R2 buckets, and Vectorize indexes.
2. **Worker Resources**: Cloudflare Workers with their configurations, bindings, and environment variables.
3. **Queue Resources**: Cloudflare Workers Queues for asynchronous processing.
4. **Service Bindings**: Connections between Workers for direct communication.
5. **Environment-Specific Configurations**: Separate configurations for dev, staging, and production environments.

The architecture follows these design principles:

- **Modularity**: Resources are organized by type and function.
- **Environment Isolation**: Clear separation between environments.
- **Dependency Management**: Explicit resource dependencies.
- **Configuration as Code**: All configuration is version-controlled.
- **Reusability**: Common patterns are abstracted into reusable components.

## Getting Started

### Prerequisites

Before working with the Pulumi infrastructure, ensure you have the following prerequisites installed and configured:

1. **Pulumi CLI**: Version 3.0.0 or higher

   ```bash
   curl -fsSL https://get.pulumi.com | sh
   ```

2. **Node.js**: Version 18.x or higher

   ```bash
   # Using nvm (recommended)
   nvm install 18
   nvm use 18
   ```

3. **pnpm**: For package management

   ```bash
   npm install -g pnpm
   ```

4. **Cloudflare API Token**: With appropriate permissions
   - Account.Workers Scripts:Edit
   - Account.Workers Routes:Edit
   - Account.Workers KV Storage:Edit
   - Account.Workers Queues:Edit
   - Account.Workers D1:Edit
   - Account.R2:Edit
   - Account.Vectorize:Edit

### Initial Setup

To set up the Pulumi project for the first time:

1. Clone the repository and navigate to the project directory:

   ```bash
   cd /home/toda/dev/dome
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Navigate to the infrastructure directory:

   ```bash
   cd infra
   ```

4. Initialize the Pulumi stacks (if not already initialized):

   ```bash
   # Initialize the dev stack
   just pulumi-stack-init dev

   # Initialize the staging stack
   just pulumi-stack-init staging

   # Initialize the production stack
   just pulumi-stack-init prod
   ```

### Authentication

To authenticate with Pulumi and Cloudflare:

1. Log in to Pulumi:

   ```bash
   pulumi login
   ```

2. Set up Cloudflare credentials as environment variables:

   ```bash
   export CLOUDFLARE_API_TOKEN=your-api-token
   export CLOUDFLARE_ACCOUNT_ID=your-account-id
   ```

   Alternatively, create a `.env.dev`, `.env.staging`, or `.env.prod` file in the `infra` directory with these variables.

## Project Structure

The Pulumi infrastructure is organized in the `infra/` directory with the following structure:

```
infra/
├── package.json             # Project dependencies
├── tsconfig.json            # TypeScript configuration
├── Pulumi.yaml              # Main project file
├── Pulumi.dev.yaml          # Dev stack configuration
├── Pulumi.staging.yaml      # Staging stack configuration
├── Pulumi.prod.yaml         # Production stack configuration
├── index.ts                 # Main entry point
├── src/
│   ├── config.ts            # Configuration and environment variables
│   ├── resources/
│   │   ├── workers.ts       # Workers definitions
│   │   ├── databases.ts     # D1 database definitions
│   │   ├── storage.ts       # R2 bucket definitions
│   │   ├── vectorize.ts     # Vectorize index definitions
│   │   ├── queues.ts        # Queue definitions
│   │   └── bindings.ts      # Service bindings
│   ├── stacks/
│   │   ├── dev.ts           # Dev environment specifics
│   │   ├── staging.ts       # Staging environment specifics
│   │   └── prod.ts          # Production environment specifics
│   └── utils/
│       ├── naming.ts        # Resource naming utilities
│       └── tags.ts          # Tagging utilities
└── scripts/
    ├── deploy.ts            # Deployment script
    └── validate.ts          # Validation script
```

Key files and their purposes:

- **index.ts**: The main entry point that selects the appropriate stack based on the environment.
- **config.ts**: Defines configuration variables and environment-specific settings.
- **resources/\*.ts**: Define the various Cloudflare resources.
- **stacks/\*.ts**: Implement environment-specific configurations and resource creation.
- **scripts/deploy.ts**: Handles the deployment process with validation and safety checks.

## Resource Management

### D1 Databases

D1 databases are defined in `src/resources/databases.ts`. Each database has a name, unique ID, and optional configuration settings.

Example of creating a D1 database:

```typescript
// In src/resources/databases.ts
export function createD1Databases(): Record<string, cloudflare.D1Database> {
  const databases: Record<string, cloudflare.D1Database> = {};

  // Create the dome-meta database
  databases.domeMeta = new cloudflare.D1Database('dome-meta', {
    name: resourceName('dome-meta'),
  });

  // Create the silo database
  databases.silo = new cloudflare.D1Database('silo', {
    name: resourceName('silo'),
  });

  return databases;
}
```

### R2 Buckets

R2 buckets are defined in `src/resources/storage.ts`. Each bucket has a name and optional configuration settings.

Example of creating an R2 bucket:

```typescript
// In src/resources/storage.ts
export function createR2Buckets(): Record<string, cloudflare.R2Bucket> {
  const buckets: Record<string, cloudflare.R2Bucket> = {};

  // Create the dome-raw bucket
  buckets.domeRaw = new cloudflare.R2Bucket('dome-raw', {
    name: resourceName('dome-raw'),
  });

  // Create the silo-content bucket
  buckets.siloContent = new cloudflare.R2Bucket('silo-content', {
    name: resourceName('silo-content'),
  });

  return buckets;
}
```

### Vectorize Indexes

Vectorize indexes are defined in `src/resources/vectorize.ts`. Each index has a name, dimensions, and optional configuration settings.

Example of creating a Vectorize index:

```typescript
// In src/resources/vectorize.ts
export function createVectorizeIndexes(): Record<string, cloudflare.VectorizeIndex> {
  const indexes: Record<string, cloudflare.VectorizeIndex> = {};

  // Create the dome-notes index
  indexes.domeNotes = new cloudflare.VectorizeIndex('dome-notes', {
    name: resourceName('dome-notes'),
    dimensions: 1536,
    metric: 'cosine',
  });

  return indexes;
}
```

### Queues

Queues are defined in `src/resources/queues.ts`. Each queue has a name and optional configuration settings.

Example of creating a queue:

```typescript
// In src/resources/queues.ts
export function createQueues(): Record<string, cloudflare.WorkersQueue> {
  const queues: Record<string, cloudflare.WorkersQueue> = {};

  // Create the new-content-constellation queue
  queues.newContentConstellation = new cloudflare.WorkersQueue('new-content-constellation', {
    name: resourceName('new-content-constellation'),
  });

  // Create the new-content-ai queue
  queues.newContentAi = new cloudflare.WorkersQueue('new-content-ai', {
    name: resourceName('new-content-ai'),
  });

  return queues;
}
```

### Workers

Workers are defined in `src/resources/workers.ts`. Each worker has a name, main module, compatibility date, and optional bindings and environment variables.

Example of creating a worker:

```typescript
// In src/resources/workers.ts
export function createWorker(
  config: WorkerConfig,
  d1Databases: Record<string, cloudflare.D1Database>,
  r2Buckets: Record<string, cloudflare.R2Bucket>,
  vectorizeIndexes: Record<string, cloudflare.VectorizeIndex>,
  queues: Record<string, cloudflare.WorkersQueue>,
): cloudflare.WorkerScript {
  // Worker configuration
  const workerConfig: cloudflare.WorkerScriptArgs = {
    name: resourceName(config.name),
    content: pulumi.interpolate`export * from '${config.mainModule}';`,
    moduleType: true,
    compatibilityDate: config.compatibilityDate,
    compatibilityFlags: config.compatibilityFlags || [],
    plainTextBindings: {
      ...commonConfig,
      ENVIRONMENT: environment,
    },
  };

  // Add bindings
  // ...

  // Create the worker script
  const worker = new cloudflare.WorkerScript(config.name, workerConfig);

  return worker;
}
```

### Service Bindings

Service bindings are defined in `src/resources/bindings.ts`. They connect workers to enable direct communication.

Example of creating service bindings:

```typescript
// In src/resources/bindings.ts
export function createServiceBindings(
  workers: Record<string, cloudflare.WorkerScript>,
): cloudflare.ServiceBinding[] {
  const bindings: cloudflare.ServiceBinding[] = [];

  // Create service binding from dome-api to constellation
  bindings.push(
    new cloudflare.ServiceBinding('dome-api-to-constellation', {
      service: workers.constellation.name,
      environment: environment,
      binding: 'CONSTELLATION',
      script: workers.domeApi.name,
    }),
  );

  // Create service binding from dome-api to silo
  bindings.push(
    new cloudflare.ServiceBinding('dome-api-to-silo', {
      service: workers.silo.name,
      environment: environment,
      binding: 'SILO',
      script: workers.domeApi.name,
    }),
  );

  return bindings;
}
```

## Deployment Workflow

The deployment workflow is managed through the justfile and the deployment script (`scripts/deploy.ts`). The workflow varies slightly depending on the target environment.

### Development Environment

The development environment is used for active development and testing. It has the most lenient safeguards and is designed for rapid iteration.

To deploy to the development environment:

1. Preview changes:

   ```bash
   just pulumi-preview dev
   ```

2. Apply changes:

   ```bash
   just pulumi-up dev
   ```

3. Destroy resources (when needed):
   ```bash
   just pulumi-destroy dev
   ```

The development environment uses the following configuration:

- Worker suffix: `-dev`
- Log level: `debug`
- Observability: Enabled with full sampling

### Staging Environment

The staging environment is used for pre-production testing. It has moderate safeguards and is designed to mirror the production environment as closely as possible.

To deploy to the staging environment:

1. Preview changes:

   ```bash
   just pulumi-preview staging
   ```

2. Apply changes:
   ```bash
   just pulumi-up staging
   ```

The staging environment uses the following configuration:

- Worker suffix: `-staging`
- Log level: `info`
- Observability: Enabled with full sampling

### Production Environment

The production environment is used for live services. It has the strictest safeguards and is designed for stability and reliability.

To deploy to the production environment:

1. Preview changes:

   ```bash
   just pulumi-preview prod
   ```

2. Apply changes:
   ```bash
   just pulumi-up prod
   ```

The production environment uses the following configuration:

- Worker suffix: None (clean names)
- Log level: `info`
- Observability: Enabled with full sampling

**Important**: The production environment has additional safeguards:

- Destroying production resources is blocked by default
- Additional validation is performed before deployment
- Changes require explicit confirmation

### Promotion Between Environments

The typical workflow for promoting changes between environments is:

1. Develop and test in the development environment
2. Promote to staging for integration testing
3. Promote to production for live deployment

To promote changes:

1. Ensure all changes are committed to version control
2. Deploy to the target environment
3. Verify the deployment
4. Update documentation if necessary

## Common Operations

### Adding New Resources

To add a new resource:

1. Identify the appropriate resource file in `src/resources/`
2. Add the resource definition
3. Update any dependencies
4. Preview and apply the changes

Example of adding a new D1 database:

```typescript
// In src/resources/databases.ts
export function createD1Databases(): Record<string, cloudflare.D1Database> {
  const databases: Record<string, cloudflare.D1Database> = {};

  // Existing databases...

  // Add a new database
  databases.newDatabase = new cloudflare.D1Database('new-database', {
    name: resourceName('new-database'),
  });

  return databases;
}
```

### Updating Existing Resources

To update an existing resource:

1. Locate the resource definition in the appropriate file
2. Modify the configuration as needed
3. Preview and apply the changes

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
      { type: 'service', name: 'NEW_SERVICE', service: 'new-service' }, // Added a new binding
    ],
    vars: {
      VERSION: '0.2.0', // Updated version
      LOG_LEVEL: 'debug',
    },
  },
  d1Databases,
  r2Buckets,
  vectorizeIndexes,
  queues,
);
```

### Removing Resources

To remove a resource:

1. Locate the resource definition in the appropriate file
2. Remove the resource definition
3. Update any dependencies
4. Preview and apply the changes

Example of removing a queue:

```typescript
// In src/resources/queues.ts
export function createQueues(): Record<string, cloudflare.WorkersQueue> {
  const queues: Record<string, cloudflare.WorkersQueue> = {};

  // Create the new-content-constellation queue
  queues.newContentConstellation = new cloudflare.WorkersQueue('new-content-constellation', {
    name: resourceName('new-content-constellation'),
  });

  // Removed the new-content-ai queue

  return queues;
}
```

### Viewing Stack Outputs

To view the outputs of a stack:

```bash
cd infra
pulumi stack output --stack dev
```

This will display all the outputs defined in the stack, such as resource IDs, URLs, and other useful information.

## Troubleshooting

### Common Deployment Issues

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

Example error and resolution:

```
error: Error creating D1 database: API token does not have the required permissions
```

Resolution: Ensure the API token has the `Account.Workers D1:Edit` permission.

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

Example error and resolution:

```
error: Error creating worker: Cannot bind to service 'constellation' because it does not exist
```

Resolution: Ensure the constellation worker is created before creating the service binding.

#### Issue: Configuration Error

**Symptoms**:

- Pulumi reports a configuration error
- Error message indicates a problem with the stack configuration

**Possible Causes**:

- Missing required configuration
- Invalid configuration values
- Environment variable issues

**Resolution**:

1. Check the stack configuration
2. Verify environment variables
3. Update the configuration as needed

Example error and resolution:

```
error: Missing required configuration variable 'cloudflare:accountId'
```

Resolution: Set the `CLOUDFLARE_ACCOUNT_ID` environment variable or add it to the stack configuration.

### State Management Issues

#### Issue: State File Corruption

**Symptoms**:

- Pulumi reports state file corruption or inconsistency
- Error message indicates a problem with the state file

**Possible Causes**:

- Manual changes to resources
- Interrupted deployment
- Concurrent deployments

**Resolution**:

1. Run `pulumi refresh` to update the state
2. Manually fix any inconsistencies
3. Consider importing resources if necessary

Example command:

```bash
cd infra
pulumi refresh --stack dev
```

#### Issue: Resource Drift

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

Example command:

```bash
cd infra
pulumi refresh --stack dev
```

### Resource-Specific Issues

#### Issue: Worker Deployment Failure

**Symptoms**:

- Worker deployment fails
- Error message indicates a problem with the worker code or configuration

**Possible Causes**:

- Invalid worker code
- Missing dependencies
- Incorrect bindings
- Compatibility issues

**Resolution**:

1. Check the worker code
2. Verify dependencies
3. Check bindings
4. Verify compatibility settings

Example error and resolution:

```
error: Error deploying worker: Module not found: services/dome-api/src/index.ts
```

Resolution: Ensure the worker module path is correct and the file exists.

#### Issue: D1 Database Issues

**Symptoms**:

- D1 database operations fail
- Error message indicates a problem with the database

**Possible Causes**:

- Database name conflicts
- Permission issues
- Resource limits

**Resolution**:

1. Check the database name
2. Verify permissions
3. Check resource limits

Example error and resolution:

```
error: Error creating D1 database: Database with name 'dome-meta-dev' already exists
```

Resolution: Use a different name for the database or import the existing database.

### Dependency Resolution Problems

#### Issue: Circular Dependencies

**Symptoms**:

- Deployment fails with a circular dependency error
- Error message indicates a circular reference between resources

**Possible Causes**:

- Resources depend on each other
- Incorrect resource references

**Resolution**:

1. Identify the circular dependency
2. Restructure the dependencies
3. Use intermediate resources if necessary

Example error and resolution:

```
error: Circular dependency detected: dome-api -> constellation -> silo -> dome-api
```

Resolution: Restructure the dependencies to break the cycle, possibly by introducing an intermediate resource.

#### Issue: Missing Dependencies

**Symptoms**:

- Deployment fails with a missing dependency error
- Error message indicates a reference to a non-existent resource

**Possible Causes**:

- Resource not created
- Incorrect resource reference
- Typo in resource name

**Resolution**:

1. Verify the referenced resource exists
2. Check the resource name
3. Create the missing resource if necessary

Example error and resolution:

```
error: Error creating service binding: Service 'constellation-dev' not found
```

Resolution: Ensure the constellation worker is created before creating the service binding, and check the name for typos.

## Best Practices

1. **Always Preview Before Applying**:

   ```bash
   just pulumi-preview <stack>
   ```

   This shows what changes will be made without actually applying them.

2. **Use Descriptive Commit Messages**:

   ```
   infra: Add new D1 database for user preferences
   ```

   This helps track infrastructure changes over time.

3. **Keep Environment Configurations Separate**:
   Use the environment-specific configuration files (`Pulumi.<env>.yaml`) for environment-specific settings.

4. **Document Resource Dependencies**:
   Clearly document dependencies between resources to make the infrastructure easier to understand and maintain.

5. **Use Resource Naming Conventions**:
   Follow consistent naming conventions for resources to avoid conflicts and improve clarity.

6. **Validate Changes Before Deployment**:
   Use the validation script to check for common issues before deployment.

7. **Monitor Resource Usage**:
   Regularly check resource usage to avoid hitting limits and ensure optimal performance.

8. **Keep Infrastructure Code DRY**:
   Use functions and abstractions to avoid duplicating code and make changes easier to manage.

9. **Secure Sensitive Information**:
   Use Pulumi's secret management for sensitive information like API keys and credentials.

10. **Regularly Update Dependencies**:
    Keep Pulumi and provider packages updated to benefit from bug fixes and new features.

## Reference

### Justfile Commands

The following justfile commands are available for managing the Pulumi infrastructure:

| Command             | Description                          | Example                      |
| ------------------- | ------------------------------------ | ---------------------------- |
| `pulumi-preview`    | Preview infrastructure changes       | `just pulumi-preview dev`    |
| `pulumi-up`         | Deploy infrastructure changes        | `just pulumi-up dev`         |
| `pulumi-destroy`    | Destroy infrastructure               | `just pulumi-destroy dev`    |
| `pulumi-stack-init` | Initialize a new stack               | `just pulumi-stack-init dev` |
| `deploy-dev`        | Deploy development environment       | `just deploy-dev`            |
| `deploy-staging`    | Deploy staging environment           | `just deploy-staging`        |
| `deploy-prod`       | Deploy production environment        | `just deploy-prod`           |
| `deploy-all`        | Deploy all environments              | `just deploy-all`            |
| `preview-all`       | Preview changes for all environments | `just preview-all`           |
| `destroy-dev`       | Destroy development environment      | `just destroy-dev`           |

### Environment Variables

The following environment variables are used by the Pulumi infrastructure:

| Variable                | Description           | Required |
| ----------------------- | --------------------- | -------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API token  | Yes      |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | Yes      |

### Pulumi CLI Commands

The following Pulumi CLI commands are useful for managing the infrastructure:

| Command               | Description                   | Example                                       |
| --------------------- | ----------------------------- | --------------------------------------------- |
| `pulumi stack ls`     | List available stacks         | `pulumi stack ls`                             |
| `pulumi stack select` | Select a stack                | `pulumi stack select dev`                     |
| `pulumi config`       | Manage stack configuration    | `pulumi config set cloudflare:accountId <id>` |
| `pulumi preview`      | Preview changes               | `pulumi preview`                              |
| `pulumi up`           | Apply changes                 | `pulumi up`                                   |
| `pulumi destroy`      | Destroy resources             | `pulumi destroy`                              |
| `pulumi refresh`      | Update state to match reality | `pulumi refresh`                              |
| `pulumi stack output` | View stack outputs            | `pulumi stack output`                         |
| `pulumi history`      | View deployment history       | `pulumi history`                              |
| `pulumi cancel`       | Cancel an update              | `pulumi cancel`                               |
