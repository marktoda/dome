# Developer Setup Guide

This guide provides comprehensive instructions for setting up your development environment for the Dome project. It covers prerequisites, initial setup, resource configuration, and troubleshooting.

## 1. Prerequisites

Before you begin, ensure you have the following tools installed:

| Tool                                                                                   | Version      | Purpose                |
| -------------------------------------------------------------------------------------- | ------------ | ---------------------- |
| [Node.js](https://nodejs.org/)                                                         | v18 or later | JavaScript runtime     |
| [pnpm](https://pnpm.io/)                                                               | v8 or later  | Package manager        |
| [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) | Latest       | Cloudflare Workers CLI |
| [just](https://github.com/casey/just)                                                  | Latest       | Command runner         |

You'll also need:

- A Cloudflare account with access to Workers, D1, Vectorize, R2, and Queues
- Git for version control

## 2. Repository Setup

### 2.1 Clone the Repository

```bash
git clone https://github.com/your-org/dome-cf.git
cd dome-cf
```

### 2.2 Install Dependencies

```bash
pnpm install
```

This command installs all dependencies across the workspace, as defined in the `pnpm-workspace.yaml` file.

### 2.3 Build the Project

```bash
just build
```

This command builds all packages and services in the correct order, respecting dependencies.

## 3. Cloudflare Resources Setup

Before you can run the project locally or deploy it, you need to set up the required Cloudflare resources.

### 3.1 Authentication

Ensure you're authenticated with Cloudflare:

```bash
wrangler login
```

This will open a browser window to authenticate with your Cloudflare account.

### 3.2 D1 Database

```bash
# Create the D1 database
wrangler d1 create dome_meta

# Apply migrations
just db-migrate-local
```

After creating the database, update the `database_id` in both the root `wrangler.toml` and `services/dome-api/wrangler.toml` files with the actual ID provided by the command output.

### 3.3 Vectorize Index

```bash
# Create the Vectorize index
wrangler vectorize create dome_notes --dimensions=1536
```

After creating the index, update the `index_id` in both the root `wrangler.toml` and `services/dome-api/wrangler.toml` files with the actual ID provided by the command output.

### 3.4 R2 Bucket

```bash
# Create the R2 bucket
wrangler r2 bucket create dome_raw
```

### 3.5 Queues

```bash
# Create the queues
wrangler queues create dome_events
wrangler queues create embed-queue
wrangler queues create content-events
wrangler queues create new-content
wrangler queues create ingest-queue
wrangler queues create ingest-dead-letter
```

## 4. Environment Configuration

### 4.1 Environment Variables

The following environment variables are used in the project:

| Variable    | Description      | Required | Default     |
| ----------- | ---------------- | -------- | ----------- |
| ENVIRONMENT | Environment name | Yes      | development |
| VERSION     | API version      | Yes      | 0.1.0       |

### 4.2 Local Development Variables

For local development, create a `.dev.vars` file in each service directory with the appropriate environment variables. For example, in `services/dome-api/.dev.vars`:

```
ENVIRONMENT=development
VERSION=0.1.0
```

### 4.3 Service-Specific Configuration

Some services require additional configuration:

#### GitHub Ingestor

For the GitHub Ingestor service, you'll need to set up a GitHub App and configure the following secrets:

```bash
wrangler secret put GITHUB_APP_ID --env development
wrangler secret put GITHUB_PRIVATE_KEY --env development
wrangler secret put GITHUB_WEBHOOK_SECRET --env development
```

## 5. Running Services Locally

### 5.1 Running Individual Services

To run a specific service locally:

```bash
just dev <service-name>
```

For example, to run the Dome API service:

```bash
just dev dome-api
```

This will start the Wrangler development server on port 8787 (or another port if specified).

### 5.2 Running Queue Consumers

To run a service with queue consumers:

```bash
cd services/<service-name>
wrangler dev --queue-consumer
```

### 5.3 Running with Local Resources

By default, the development server will use your production Cloudflare resources. To use local resources instead, you can use the `--local` flag with Wrangler:

```bash
cd services/<service-name>
wrangler dev --local
```

Note that not all Cloudflare resources have local equivalents.

## 6. Testing

### 6.1 Running All Tests

To run tests for all packages and services:

```bash
just test
```

### 6.2 Running Tests for a Specific Package

To run tests for a specific package or service:

```bash
just test-pkg <package-name>
```

For example, to run tests for the Silo service:

```bash
just test-pkg silo
```

### 6.3 Test Coverage

To run tests with coverage reporting:

```bash
just test-coverage
```

## 7. Linting and Formatting

### 7.1 Running Linting

To run linting across the entire project:

```bash
just lint
```

### 7.2 Fixing Linting Issues

To automatically fix linting issues where possible:

```bash
just lint-fix
```

### 7.3 Formatting Code

To format code according to project standards:

```bash
just format
```

## 8. Database Operations

### 8.1 Creating a New Migration

To create a new database migration:

```bash
just db-migrate "<migration_name>"
```

This will create a new migration file in the appropriate service's migrations directory.

### 8.2 Applying Migrations Locally

To apply migrations to your local development database:

```bash
just db-migrate-local
```

### 8.3 Applying Migrations to Production

To apply migrations to the production database:

```bash
just db-migrate-prod
```

## 9. Deployment

### 9.1 Deploying a Specific Service

To deploy a specific service to production:

```bash
just deploy <service-name>
```

For example, to deploy the Dome API service:

```bash
just deploy dome-api
```

### 9.2 Deploying All Services

To deploy all services:

```bash
just deploy
```

### 9.3 Deployment Environments

The project supports multiple deployment environments. To deploy to a specific environment:

```bash
just deploy-env <service-name> <environment>
```

For example, to deploy the Dome API service to staging:

```bash
just deploy-env dome-api staging
```

## 10. Troubleshooting

### 10.1 Common Issues

#### Wrangler Authentication Issues

If you encounter authentication issues with Wrangler:

```bash
wrangler login
```

#### D1 Migration Errors

If you encounter errors with D1 migrations:

- Ensure your SQL syntax is compatible with D1
- Check the [D1 documentation](https://developers.cloudflare.com/d1/) for supported features

#### Vectorize Errors

If you encounter errors with Vectorize:

- Ensure your embedding dimensions match the index configuration
- Verify that the Vectorize index ID is correctly set in your wrangler.toml file

#### R2 Access Issues

If you encounter issues with R2:

- Verify your R2 bucket permissions
- Check your CORS configuration if accessing from a browser

### 10.2 Debugging Techniques

#### Wrangler Logs

To view logs for a deployed service:

```bash
wrangler tail <service-name>
```

#### Local Development Logs

When running a service locally, logs will be displayed in the terminal.

#### Checking Resource Status

To check the status of your Cloudflare resources:

```bash
wrangler d1 list
wrangler r2 bucket list
wrangler vectorize list
wrangler queues list
```

### 10.3 Getting Help

If you encounter any issues not covered here:

- Check the Cloudflare Workers documentation
- Consult the project's internal documentation
- Reach out to the team
- Create an issue in the repository

## 11. Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare D1 Documentation](https://developers.cloudflare.com/d1/)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
- [Cloudflare Vectorize Documentation](https://developers.cloudflare.com/vectorize/)
- [Cloudflare Queues Documentation](https://developers.cloudflare.com/queues/)
- [pnpm Documentation](https://pnpm.io/documentation)
- [just Documentation](https://github.com/casey/just)
