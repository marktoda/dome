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
build:
    pnpm run build

# Build and prepare for deployment
build-deploy:
    # First build TypeScript
    pnpm run build
    # Then prepare for deployment with wrangler
    cd services/dome-api && wrangler deploy --dry-run --outdir=dist

# Build a specific package
build-pkg PACKAGE:
    pnpm --filter {{ PACKAGE }} build

# Run development server for a specific service
dev SERVICE="dome-api":
    wrangler dev -c ./services/{{ SERVICE }}/wrangler.toml

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

# Preview Pulumi changes for a specific environment
pulumi-preview ENV="dev":
    cd infrastructure && pnpm exec pulumi preview --stack {{ ENV }}

# Deploy with Pulumi to a specific environment
pulumi-up ENV="dev":
    cd infrastructure && pnpm exec pulumi up --stack {{ ENV }} --yes

# Destroy Pulumi resources for a specific environment
pulumi-destroy ENV="dev":
    cd infrastructure && pnpm exec pulumi destroy --stack {{ ENV }} --yes

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

# Setup local development environment
setup-local:
    @echo "Setting up local development environment..."
    pnpm install
    pnpm build
    @echo "Local development environment setup complete!"

# Generate D1 database migrations
db-migrate NAME:
    wrangler d1 migrations create dome_meta {{ NAME }}

# Apply D1 database migrations locally
db-migrate-local:
    wrangler d1 migrations apply dome_meta --local

# Apply D1 database migrations to production
db-migrate-prod:
    wrangler d1 migrations apply dome_meta

# Create a new KV namespace
kv-create NAME:
    wrangler kv:namespace create {{ NAME }}

# Create a new R2 bucket
r2-create NAME:
    wrangler r2 bucket create {{ NAME }}

# Create a new Queue
queue-create NAME:
    wrangler queues create {{ NAME }}

# Deploy all services
deploy-all ENV="dev":
    just pulumi-up {{ ENV }}

# Deploy a specific service
deploy SERVICE ENV="dev":
    # First build TypeScript
    pnpm --filter {{ SERVICE }} build
    # Then deploy with wrangler
    cd services/{{ SERVICE }} && wrangler deploy

# Generate a new Pulumi stack
pulumi-stack-init ENV:
    cd infrastructure && pnpm exec pulumi stack init {{ ENV }}

# Show logs for a service
logs SERVICE:
    cd services/{{ SERVICE }} && wrangler tail

# Run a one-off command in a specific package
run PACKAGE COMMAND:
    pnpm --filter {{ PACKAGE }} {{ COMMAND }}

# Setup the CLI TUI
setup-tui:
    @echo "Setting up the CLI TUI..."
    pnpm --filter @dome/cli install
    pnpm --filter @dome/cli build
    @echo "CLI TUI setup complete! Run 'just run-tui' to start the TUI."

# Run the CLI TUI
run-tui:
    @echo "Starting the CLI TUI..."
    pnpm --filter @dome/cli exec dome tui
