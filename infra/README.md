# Dome Infrastructure

This directory contains the infrastructure as code (IaC) for the Dome project using Pulumi. The infrastructure is defined in TypeScript and deployed to Cloudflare.

## Directory Structure

- `src/` - Contains the TypeScript source code for the infrastructure
  - `config.ts` - Configuration for the infrastructure
  - `resources/` - Resource definitions (databases, workers, etc.)
  - `stacks/` - Stack-specific configurations (dev, staging, prod)
  - `utils/` - Utility functions
- `scripts/` - Contains scripts for deployment, validation, and other tasks
- `Pulumi.yaml` - Pulumi project configuration
- `Pulumi.<stack>.yaml` - Stack-specific configuration files

## Available Commands

The following commands are available in the justfile at the root of the repository:

### Deployment Commands

- `just deploy-all` - Deploy all infrastructure resources across all environments (dev, staging, prod)
- `just deploy-dev` - Deploy only the development environment resources
- `just deploy-staging` - Deploy only the staging environment resources
- `just deploy-prod` - Deploy only the production environment resources

### Preview Commands

- `just preview-all` - Preview changes without deploying for all environments
- `just pulumi-preview ENV` - Preview changes for a specific environment (default: dev)

### Destruction Commands

- `just destroy-dev` - Destroy the development environment (for testing purposes)
- `just pulumi-destroy ENV` - Destroy a specific environment (use with caution)

### Other Commands

- `just pulumi-stack-init ENV` - Initialize a new Pulumi stack for the specified environment

## Deployment Process

The deployment process is handled by the `scripts/deploy.ts` script, which:

1. Checks for required tools (Pulumi CLI, Node.js)
2. Installs dependencies if needed
3. Sets up environment variables
4. Selects the appropriate Pulumi stack
5. Builds the TypeScript project
6. Validates the deployment
7. Runs the Pulumi action (preview, up, destroy)
8. Verifies the deployment after completion

## Safeguards

The following safeguards are in place to prevent accidental destruction of resources:

1. Production environment cannot be destroyed using the `destroy-dev` command
2. The `deploy.ts` script includes additional checks for production environments
3. Validation is performed before any deployment to catch potential issues
4. Confirmation is required before destroying any resources

## Environment Setup

Each environment (dev, staging, prod) has its own Pulumi stack with specific configuration. Environment-specific variables can be set in the `.env.<stack>` files.

## Adding New Resources

To add new Cloudflare resources:

1. Define the resource in the appropriate file in `src/resources/`
2. Export the resource from the file
3. Import and use the resource in the appropriate stack file in `src/stacks/`
4. Run `just preview-all` to verify the changes
5. Deploy using the appropriate command

## Troubleshooting

If you encounter issues with the deployment:

1. Check the Pulumi logs for error messages
2. Verify that you have the correct permissions in Cloudflare
3. Ensure that all required environment variables are set
4. Run the validation script to check for potential issues
5. Try running the Pulumi command directly for more detailed error messages