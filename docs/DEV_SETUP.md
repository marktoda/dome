# Developer Setup Guide for Dome Project

This document provides instructions for setting up your development environment for the Dome project.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [pnpm](https://pnpm.io/) (v8 or later)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (latest version)
- [just](https://github.com/casey/just) command runner
- Cloudflare account with access to Workers, D1, Vectorize, R2, and Queues

## Initial Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/your-org/dome-cf.git
   cd dome-cf
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Build the project:
   ```bash
   just build
   ```

## Cloudflare Resources Setup

Before you can run the project locally or deploy it, you need to set up the required Cloudflare resources:

### D1 Database

```bash
# Create the D1 database
wrangler d1 create dome_meta

# Apply migrations
just db-migrate-local
```

After creating the database, update the `database_id` in both the root `wrangler.toml` and `services/dome-api/wrangler.toml` files with the actual ID.

### Vectorize Index

```bash
# Create the Vectorize index
wrangler vectorize create dome_notes --dimensions=1536
```

After creating the index, update the `index_id` in both the root `wrangler.toml` and `services/dome-api/wrangler.toml` files with the actual ID.

### R2 Bucket

```bash
# Create the R2 bucket
wrangler r2 bucket create dome_raw
```

### Queue

```bash
# Create the queue
wrangler queues create dome_events
```

## Environment Variables

The following environment variables are used in the project:

| Variable    | Description      | Required | Default     |
| ----------- | ---------------- | -------- | ----------- |
| ENVIRONMENT | Environment name | Yes      | development |
| VERSION     | API version      | Yes      | 0.1.0       |

For local development, you can create a `.dev.vars` file in the `services/dome-api` directory with the following content:

```
ENVIRONMENT=development
VERSION=0.1.0
```

## Running Locally

To run the API service locally:

```bash
just dev dome-api
```

This will start the Wrangler development server on port 8787.

## Testing

To run tests:

```bash
just test
```

To run tests for a specific package:

```bash
just test-pkg dome-api
```

## Linting

To run linting:

```bash
just lint
```

To fix linting issues:

```bash
just lint-fix
```

## Deployment

To deploy to production:

```bash
just deploy dome-api
```

## Database Migrations

To create a new migration:

```bash
just db-migrate "migration_name"
```

To apply migrations locally:

```bash
just db-migrate-local
```

To apply migrations to production:

```bash
just db-migrate-prod
```

## CI/CD Pipeline

The project uses GitHub Actions for CI/CD. The pipeline includes:

1. Installing dependencies
2. Linting
3. Building
4. Running tests
5. Validating deployment with `wrangler deploy --dry-run`
6. Validating D1 migrations with `wrangler d1 migrations apply --dry-run`

The pipeline runs on every push to the main branch and on pull requests.

## Troubleshooting

### Common Issues

1. **Wrangler authentication issues**: Run `wrangler login` to authenticate with your Cloudflare account.

2. **D1 migration errors**: Ensure your SQL syntax is compatible with D1. Check the [D1 documentation](https://developers.cloudflare.com/d1/) for supported features.

3. **Vectorize errors**: Ensure your embedding dimensions match the index configuration.

4. **R2 access issues**: Verify your R2 bucket permissions and CORS configuration.

### Getting Help

If you encounter any issues not covered here, please reach out to the team or create an issue in the repository.
