# Cloudflare Workers Microservices Monorepo

This repository contains a microservices architecture built on Cloudflare Workers, managed as a monorepo. The infrastructure is defined using Pulumi for automated deployments.

## Project Structure

```
communicator-cloudflare/
├── .github/                          # GitHub configuration
│   └── workflows/                    # CI/CD workflows
│       └── ci.yml                    # Continuous Integration workflow
├── infrastructure/                   # Pulumi infrastructure code
│   ├── src/
│   │   ├── index.ts                  # Main Pulumi program
│   │   ├── workers.ts                # Workers infrastructure
│   │   └── environments/
│   │       └── dev.ts                # Development environment configuration
│   ├── package.json
│   └── tsconfig.json
├── packages/                         # Shared packages
│   └── common/                       # Shared code, types, utilities
│       ├── src/
│       │   └── types/
│       ├── package.json
│       └── tsconfig.json
├── services/                         # Microservices
│   └── ingestor/                     # Ingestor service
│       ├── src/
│       │   └── index.ts              # Service entry point
│       ├── wrangler.toml             # Wrangler configuration
│       ├── package.json
│       └── tsconfig.json
├── package.json                      # Root package.json for monorepo
├── tsconfig.json                     # Base TypeScript configuration
└── pnpm-workspace.yaml               # PNPM workspace configuration
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or later)
- [PNPM](https://pnpm.io/) for package management
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) for local development
- [Pulumi CLI](https://www.pulumi.com/docs/get-started/install/) for infrastructure deployment
- [Just](https://github.com/casey/just) command runner for development workflows

### Setup

1. Clone the repository
2. Install dependencies:
   ```
   pnpm install
   ```

### Local Development

To run the ingestor service locally:

```bash
# Navigate to the service directory
cd services/ingestor

# Start the local development server
pnpm dev
```

This will start a local development server at http://localhost:8787 where you can test the service.

### Using the Justfile

This project includes a [justfile](https://github.com/casey/just) that provides convenient commands for common development tasks.

#### Installing Just

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

#### Common Just Commands

```bash
# List all available commands
just

# Install dependencies
just install

# Run the ingestor service in development mode
just dev

# Run a specific service in development mode
just dev conversations

# Build all packages
just build

# Deploy to development environment
just deploy-all dev

# Create a new TypeScript service
just new-service my-service-name

# Create a new Rust service
just new-rust-service my-rust-service

# Run tests
just test

# Preview Pulumi changes
just pulumi-preview
```

For a complete list of available commands, run `just` without arguments.

### Deployment

Deployments are managed through Pulumi:

```bash
# Navigate to the infrastructure directory
cd infrastructure

# Preview changes
pulumi preview

# Deploy
pulumi up
```

## Services

### Ingestor Service

A simple "Hello World" service that demonstrates the basic structure of a Cloudflare Worker in this architecture.

Endpoints:
- `GET /` - Returns a simple JSON response with a "Hello World" message and service information
- `GET /health` - Health check endpoint that returns the service status

## Hono Framework Integration

This project uses the [Hono](https://hono.dev/) framework for building Cloudflare Workers. Hono provides:

- Fast and lightweight routing
- Middleware support
- TypeScript-first development
- Built-in utilities for common web tasks

### Hono Worker Structure

Hono workers use the following pattern:

```typescript
import { Hono } from 'hono';

// Define environment bindings
type Bindings = {
  ENVIRONMENT?: string;
};

// Create Hono app with bindings
const app = new Hono<{ Bindings: Bindings }>();

// Add middleware
app.use('*', logger());
app.use('*', cors());

// Define routes
app.get('/', (c) => {
  return c.json({ message: 'Hello World!' });
});

// Export the Hono app as the default export
export default app;
```

### Creating a New Hono-based Service

To create a new service using Hono:

```bash
just new-hono-service my-service-name
```

This will create a new service with the Hono framework already set up, including:
- Basic middleware (logging, CORS)
- Standard route structure
- Health check endpoint
- Environment variable handling

## Documentation

Comprehensive documentation for this project is available in the [docs](./docs) directory:

- [Architecture Overview](./docs/architecture.md) - Detailed system architecture, data flow, and implementation details
- [Hono Framework Integration](./docs/hono-integration.md) - Information about the Hono framework integration
- [Justfile Commands](./docs/justfile-commands.md) - Detailed information about available justfile commands

## Quick Start

To create a new service:

```bash
# Create a new TypeScript service with Hono
just new-service my-service-name

# Create a new Rust service (WebAssembly)
just new-rust-service my-rust-service
```

To run a service locally:

```bash
# Run the ingestor service
just dev ingestor

# Run a specific service
just dev my-service-name
```

To build and deploy a service:

```bash
# Build TypeScript code
just build

# Deploy a specific service
just deploy my-service-name
```

The build process has been simplified to avoid infinite loops:
1. `just build` runs TypeScript compilation
2. `just deploy` builds and then uses wrangler to deploy

We've made several improvements to ensure the project builds correctly:
1. Fixed the justfile to use template files instead of inline code, which resolves parsing issues
2. Updated the TypeScript configuration to properly handle imports between packages
3. Verified that the project builds successfully with `pnpm build`

## Worker Types

This monorepo supports multiple types of Cloudflare Workers:

### TypeScript/JavaScript Workers

TypeScript workers use the following configuration in `wrangler.toml`:

```toml
name = "my-worker"
main = "src/index.ts"  # Entry point for the worker
compatibility_date = "2023-04-15"

[build]
command = "pnpm build"
```

The entry point is specified in the `main` field, which points to the TypeScript file that exports the worker handler.

### Rust Workers

Rust workers use a different approach, compiling to WebAssembly:

```toml
name = "my-rust-worker"
compatibility_date = "2023-04-15"

[build]
command = "cargo build --release --target wasm32-unknown-unknown"
output_path = "target/wasm32-unknown-unknown/release/my_rust_worker.wasm"
```

For Rust workers:
- No `main` field is specified
- The `[build]` section defines how to compile the Rust code to WebAssembly
- The `output_path` points to the compiled WebAssembly file

To create a new Rust worker, use the `just new-rust-service` command, which will set up the appropriate project structure and configuration.
