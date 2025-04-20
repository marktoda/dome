# Dome Cloudflare Justfile
# Usage: just <command>

# List all available commands
default:
    @just --list

# Install all dependencies
install:
    pnpm install

# Clean all build artifacts
clean:
    rm -rf **/dist **/node_modules **/.turbo

# Reinstall all dependencies from scratch
reinstall: clean install

# Build all packages
build: install
    pnpm run build

# Build a specific package
build-pkg PACKAGE: install
    pnpm --filter {{ PACKAGE }} build

# Deploy a specific service (builds first)
deploy SERVICE ENV="dev": build
    # Then deploy with wrangler
    wrangler -c services/{{ SERVICE }}/wrangler.toml deploy

# Run development server for a specific service
dev: build
    wrangler dev \
      -c services/dome-api/wrangler.toml \
      -c services/constellation/wrangler.toml \
      -c services/silo/wrangler.toml \
      --experimental-vectorize-bind-to-prod

# Run tests for all packages
test:
    pnpm run test

# Run tests for a specific package
test-pkg PACKAGE:
    pnpm --filter {{ PACKAGE }} test

# Run linting for all packages
lint:
    pnpm run lint

# Run linting with auto-fix for all packages
lint-fix:
    pnpm run lint:fix

# Run linting for a specific package
lint-pkg PACKAGE:
    pnpm --filter {{ PACKAGE }} lint

# Run linting with auto-fix for a specific package
lint-fix-pkg PACKAGE:
    pnpm --filter {{ PACKAGE }} lint -- --fix

# Run type checking for all packages
typecheck:
    pnpm run typecheck

# Format all code
format:
    pnpm run format

# Setup local development environment
setup-local: install build
    @echo "Local development environment setup complete!"

# Pulumi commands
pulumi-preview ENV="dev":
    cd infrastructure && pnpm exec pulumi preview --stack {{ ENV }}

pulumi-up ENV="dev":
    cd infrastructure && pnpm exec pulumi up --stack {{ ENV }} --yes

pulumi-destroy ENV="dev":
    cd infrastructure && pnpm exec pulumi destroy --stack {{ ENV }} --yes

pulumi-stack-init ENV:
    cd infrastructure && pnpm exec pulumi stack init {{ ENV }}

# Deploy all services using Pulumi
deploy-all ENV="dev": build
    just pulumi-up {{ ENV }}

# Create a new TypeScript service with Hono
new-service NAME:
    @echo "Creating new service: {{ NAME }}"
    # Create directory structure
    mkdir -p services/{{ NAME }}/src
    # Copy the service template and update the name
    cat templates/service-template.json | sed 's/"service-template"/"{{ NAME }}"/g' > services/{{ NAME }}/package.json
    cp -r services/ingestor/tsconfig.json services/ingestor/wrangler.toml services/{{ NAME }}/
    sed -i 's/name = "ingestor"/name = "{{ NAME }}"/g' services/{{ NAME }}/wrangler.toml
    # Copy the TypeScript template and replace the service name
    cp templates/typescript-service-template.ts services/{{ NAME }}/src/index.ts
    sed -i 's/SERVICE_NAME/{{ NAME }}/g' services/{{ NAME }}/src/index.ts
    # Create ESLint configuration
    echo 'module.exports = {\n  extends: ["../../.eslintrc.js"],\n  parserOptions: {\n    project: "./tsconfig.json",\n    tsconfigRootDir: __dirname,\n  },\n  rules: {\n    // Service-specific overrides can be added here\n  },\n};' > services/{{ NAME }}/.eslintrc.js
    @echo "Service {{ NAME }} created successfully!"

# Create a new Rust service (WebAssembly)
new-rust-service NAME:
    @echo "Creating new Rust service: {{ NAME }}"
    # Create directory structure and copy templates
    mkdir -p services/{{ NAME }}
    cp -r templates/rust-worker/* services/{{ NAME }}/
    # Update service name in configuration files
    sed -i 's/rust-worker-template/{{ NAME }}/g' services/{{ NAME }}/Cargo.toml
    sed -i 's/rust-worker-template/{{ NAME }}/g' services/{{ NAME }}/wrangler.toml
    sed -i 's/rust_worker.wasm/{{ NAME }}.wasm/g' services/{{ NAME }}/wrangler.toml
    sed -i 's/"rust-worker-template"/"{{ NAME }}"/g' services/{{ NAME }}/src/lib.rs
    # Create a .eslintrc.js file for any JavaScript/TypeScript files in the Rust service
    echo 'module.exports = {\n  extends: ["../../.eslintrc.js"],\n  parserOptions: {\n    project: "./tsconfig.json",\n    tsconfigRootDir: __dirname,\n  },\n  rules: {\n    // Service-specific overrides can be added here\n  },\n};' > services/{{ NAME }}/.eslintrc.js
    @echo "Rust service {{ NAME }} created successfully!"

# Database commands
db-migrate NAME:
    wrangler -c wrangler.shared.toml d1 migrations create dome-meta {{ NAME }}

db-migrate-local:
    wrangler -c wrangler.shared.toml d1 migrations apply dome-meta --local

db-migrate-remote:
    wrangler -c wrangler.shared.toml d1 migrations apply dome-meta --remote

db-migrate-prod:
    wrangler -c wrangler.shared.toml d1 migrations apply dome-meta

# Apply D1 database migrations locally
db-setup:
    @echo "Applying database migrations locally..."
    wrangler -c wrangler.shared.toml d1 migrations apply dome-meta --local
    @echo "Database migrations applied successfully!"

# Run the API server in remote mode (without applying migrations)
api-run-remote:
    @echo "Starting the dome-api server with remote mode..."
    wrangler -c services/dome-api/wrangler.toml dev --remote

# Apply D1 database migrations locally and start the API server
db-setup-and-run:
    @echo "Applying database migrations locally..."
    wrangler -c wrangler.shared.toml d1 migrations apply dome-meta --local
    @echo "Starting the dome-api server with remote mode..."
    wrangler -c services/dome-api/wrangler.toml dev --remote

# Show logs for a service
logs SERVICE:
    wrangler -c services/{{ SERVICE }}/wrangler.toml tail

# Run a one-off command in a specific package
run PACKAGE COMMAND:
    pnpm --filter {{ PACKAGE }} {{ COMMAND }}

tui:
    @echo "Starting the prompt-based CLI TUI..."
    pnpm --filter cli start tui

cli *ARGS:
    @echo "Starting the prompt‑based CLI"
    pnpm --filter cli start {{ ARGS }}
