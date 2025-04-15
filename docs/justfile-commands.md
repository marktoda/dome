# Justfile Commands

This document provides detailed information about the commands available in the justfile for the Communicator Cloudflare project.

## Table of Contents

1. [Introduction](#introduction)
2. [Installation](#installation)
3. [Basic Commands](#basic-commands)
4. [Development Commands](#development-commands)
5. [Build Commands](#build-commands)
6. [Service Creation Commands](#service-creation-commands)
7. [Infrastructure Commands](#infrastructure-commands)
8. [Database Commands](#database-commands)
9. [Deployment Commands](#deployment-commands)
10. [Utility Commands](#utility-commands)

## Introduction

The Communicator Cloudflare project uses [just](https://github.com/casey/just) as a command runner to simplify common development tasks. Just is a handy way to save and run project-specific commands.

## Installation

### Installing Just

Before you can use the justfile commands, you need to install the just command runner:

```bash
# macOS
brew install just

# Linux
# Download the binary from https://github.com/casey/just/releases
# or use your package manager

# Windows
scoop install just
# or
choco install just
```

### Listing Available Commands

To see a list of all available commands:

```bash
just
```

## Basic Commands

### Installing Dependencies

```bash
# Install all dependencies
just install

# Clean all build artifacts
just clean

# Reinstall all dependencies from scratch
just reinstall
```

## Development Commands

### Running Services

```bash
# Run the ingestor service in development mode
just dev ingestor

# Run a specific service in development mode
just dev service-name

# Run all services in development mode
just dev-all
```

### Testing

```bash
# Run tests for all packages
just test

# Run tests for a specific package
just test-pkg package-name

# Run linting for all packages
just lint

# Run type checking for all packages
just typecheck

# Format all code
just format
```

## Build Commands

```bash
# Build all packages
just build

# Build a specific package
just build-pkg package-name
```

## Service Creation Commands

### Creating TypeScript Services

```bash
# Create a new TypeScript service
just new-service my-service-name
```

### Creating Hono-based Services

```bash
# Create a new Hono-based TypeScript service
just new-hono-service my-service-name
```

### Creating Rust Services

```bash
# Create a new Rust service
just new-rust-service my-rust-service
```

### Updating Existing Services

```bash
# Update an existing service to use Hono
just update-to-hono service-name
```

## Infrastructure Commands

### Pulumi Commands

```bash
# Preview Pulumi changes for a specific environment
just pulumi-preview dev

# Deploy with Pulumi to a specific environment
just pulumi-up dev

# Destroy Pulumi resources for a specific environment
just pulumi-destroy dev

# Generate a new Pulumi stack
just pulumi-stack-init env-name
```

## Database Commands

### D1 Database Commands

```bash
# Generate D1 database migrations
just db-migrate migration-name

# Apply D1 database migrations locally
just db-migrate-local

# Apply D1 database migrations to production
just db-migrate-prod
```

## Cloudflare Resource Commands

```bash
# Create a new KV namespace
just kv-create namespace-name

# Create a new R2 bucket
just r2-create bucket-name

# Create a new Queue
just queue-create queue-name
```

## Deployment Commands

```bash
# Deploy all services
just deploy-all dev

# Deploy a specific service
just deploy service-name dev
```

## Utility Commands

```bash
# Setup local development environment
just setup-local

# Show logs for a service
just logs service-name

# Run a one-off command in a specific package
just run package-name command
```

## Command Details

### `just install`

Installs all dependencies using PNPM.

```bash
just install
```

### `just clean`

Removes all build artifacts, including `dist`, `node_modules`, and `.turbo` directories.

```bash
just clean
```

### `just reinstall`

Combines `clean` and `install` to completely reinstall all dependencies.

```bash
just reinstall
```

### `just build`

Builds all packages in the monorepo.

```bash
just build
```

### `just build-pkg PACKAGE`

Builds a specific package.

```bash
just build-pkg @communicator/common
```

### `just dev SERVICE`

Runs a specific service in development mode using Wrangler.

```bash
just dev ingestor
```

### `just dev-all`

Runs all services in development mode.

```bash
just dev-all
```

### `just test`

Runs tests for all packages.

```bash
just test
```

### `just test-pkg PACKAGE`

Runs tests for a specific package.

```bash
just test-pkg @communicator/common
```

### `just lint`

Runs linting for all packages.

```bash
just lint
```

### `just typecheck`

Runs type checking for all packages.

```bash
just typecheck
```

### `just format`

Formats all code using the project's formatting rules.

```bash
just format
```

### `just new-service NAME`

Creates a new TypeScript service with the specified name.

```bash
just new-service my-service-name
```

This command:
1. Creates a new directory for the service
2. Copies the necessary configuration files
3. Creates a basic TypeScript service

### `just new-hono-service NAME`

Creates a new Hono-based TypeScript service with the specified name.

```bash
just new-hono-service my-service-name
```

This command:
1. Creates a new directory for the service
2. Copies the necessary configuration files
3. Creates a Hono-based TypeScript service with middleware and routes

### `just new-rust-service NAME`

Creates a new Rust service with the specified name.

```bash
just new-rust-service my-rust-service
```

This command:
1. Creates a new directory for the service
2. Copies the Rust template files
3. Updates the service name in the configuration files

### `just update-to-hono SERVICE`

Updates an existing service to use the Hono framework.

```bash
just update-to-hono service-name
```

This command:
1. Adds Hono as a dependency
2. Backs up the original index.ts file
3. Creates a new Hono-based index.ts file

### `just pulumi-preview ENV`

Previews Pulumi changes for a specific environment.

```bash
just pulumi-preview dev
```

### `just pulumi-up ENV`

Deploys with Pulumi to a specific environment.

```bash
just pulumi-up dev
```

### `just pulumi-destroy ENV`

Destroys Pulumi resources for a specific environment.

```bash
just pulumi-destroy dev
```

### `just pulumi-stack-init ENV`

Generates a new Pulumi stack for the specified environment.

```bash
just pulumi-stack-init staging
```

### `just db-migrate NAME`

Generates a D1 database migration with the specified name.

```bash
just db-migrate add-users-table
```

### `just db-migrate-local`

Applies D1 database migrations locally.

```bash
just db-migrate-local
```

### `just db-migrate-prod`

Applies D1 database migrations to production.

```bash
just db-migrate-prod
```

### `just kv-create NAME`

Creates a new KV namespace with the specified name.

```bash
just kv-create my-namespace
```

### `just r2-create NAME`

Creates a new R2 bucket with the specified name.

```bash
just r2-create my-bucket
```

### `just queue-create NAME`

Creates a new Queue with the specified name.

```bash
just queue-create my-queue
```

### `just deploy-all ENV`

Deploys all services to the specified environment.

```bash
just deploy-all dev
```

### `just deploy SERVICE ENV`

Deploys a specific service to the specified environment.

```bash
just deploy ingestor dev
```

### `just setup-local`

Sets up the local development environment.

```bash
just setup-local
```

### `just logs SERVICE`

Shows logs for a specific service.

```bash
just logs ingestor
```

### `just run PACKAGE COMMAND`

Runs a one-off command in a specific package.

```bash
just run @communicator/common build