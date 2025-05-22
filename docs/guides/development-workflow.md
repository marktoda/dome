# Development Workflow Guide

This guide outlines the recommended development workflow for the Dome project. It covers the entire development lifecycle from setting up your environment to deploying changes to production.

## 1. Development Environment Setup

Before you begin development, ensure you have set up your environment according to the [Setup Guide](./setup.md).

## 2. Repository Structure

Understanding the repository structure is essential for effective development:

```
dome/
├── docs/                  # Documentation
├── infrastructure/        # Infrastructure as code
├── packages/              # Shared packages and libraries
│   ├── common/            # Common utilities and shared code
│   ├── errors/            # Error handling utilities
│   └── ...
├── services/              # Individual microservices
│   ├── dome-api/          # Main API service
│   ├── silo/              # Content storage service
│   ├── constellation/     # Embedding service
│   ├── github-ingestor/   # GitHub ingestion service
│   └── ...
├── templates/             # Templates for new services
│   ├── rust-worker/       # Template for Rust-based workers
│   └── ...
├── justfile               # Command definitions for the just tool
└── pnpm-workspace.yaml    # pnpm workspace configuration
```

## 3. Branch Management

### 3.1 Branch Naming Convention

Use the following naming convention for branches:

- `feature/<feature-name>` - For new features
- `fix/<issue-name>` - For bug fixes
- `refactor/<refactor-name>` - For code refactoring
- `docs/<docs-name>` - For documentation changes
- `chore/<chore-name>` - For maintenance tasks

### 3.2 Branch Workflow

1. **Create a new branch from main**:

   ```bash
   git checkout main
   git pull
   git checkout -b feature/my-feature
   ```

2. **Make your changes and commit them**:

   ```bash
   git add .
   git commit -m "feat: add new feature"
   ```

   Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification for commit messages.

3. **Push your branch to the remote repository**:

   ```bash
   git push -u origin feature/my-feature
   ```

4. **Create a pull request** from your branch to the main branch.

5. **Address review feedback** and make additional commits as needed.

6. **Merge the pull request** once it has been approved and all checks pass.

## 4. Development Cycle

### 4.1 Planning

1. **Understand the requirements** for the feature or fix you're implementing.
2. **Break down the task** into smaller, manageable steps.
3. **Identify dependencies** and potential impacts on other parts of the system.

### 4.2 Implementation

1. **Create a new branch** for your feature or fix.
2. **Implement the changes** according to the requirements.
3. **Write tests** to verify your implementation.
4. **Run linting and formatting** to ensure code quality:
   ```bash
   just lint
   just format
   ```
5. **Run tests** to ensure your changes don't break existing functionality:
   ```bash
   just test-pkg <package-name>
   ```

### 4.3 Local Testing

1. **Run the service locally**:
   ```bash
   just dev <service-name>
   ```
2. **Test your changes** using appropriate tools (browser, API client, etc.).
3. **Debug issues** using the browser console, worker logs, or other debugging tools.

### 4.4 Code Review

1. **Create a pull request** with a clear description of your changes.
2. **Request reviews** from appropriate team members.
3. **Address review feedback** and make additional commits as needed.
4. **Ensure all checks pass** before merging.

### 4.5 Deployment

1. **Merge the pull request** to the main branch.
2. **Deploy the changes** to the appropriate environment:
   ```bash
   just deploy <service-name>
   ```
3. **Verify the deployment** by testing the changes in the deployed environment.

## 5. Working with pnpm Workspace

The Dome project uses pnpm workspaces for managing dependencies across multiple packages and services.

### 5.1 Installing Dependencies

To install dependencies for all packages:

```bash
pnpm install
```

To add a dependency to a specific package:

```bash
pnpm add <package> --filter <workspace-package>
```

For example, to add the `zod` package to the `dome-api` service:

```bash
pnpm add zod --filter dome-api
```

To add a dependency to all packages:

```bash
pnpm add -w <package>
```

### 5.2 Running Scripts

To run a script in a specific package:

```bash
pnpm --filter <workspace-package> <script>
```

For example, to run the build script for the `silo` service:

```bash
pnpm --filter silo build
```

To run the same script across all packages:

```bash
pnpm -r <script>
```

## 6. Working with Cloudflare Resources

### 6.1 D1 Database

#### Creating a Migration

To create a new migration:

```bash
just db-migrate "<migration_name>"
```

#### Applying Migrations

To apply migrations locally:

```bash
just db-migrate-local
```

To apply migrations to production:

```bash
just db-migrate-prod
```

### 6.2 R2 Storage

To interact with R2 storage:

```bash
# List buckets
wrangler r2 bucket list

# List objects in a bucket
wrangler r2 object list <bucket-name>

# Upload an object
wrangler r2 object put <bucket-name>/<key> --file <local-file>

# Download an object
wrangler r2 object get <bucket-name>/<key> --file <local-file>
```

### 6.3 Vectorize

To interact with Vectorize:

```bash
# List indexes
wrangler vectorize list

# Get index info
wrangler vectorize get <index-name>

# Create a metadata index
wrangler vectorize create-metadata-index <index-name> --property-name <property> --type <type>
```

### 6.4 Queues

To interact with Queues:

```bash
# List queues
wrangler queues list

# Create a queue
wrangler queues create <queue-name>

# Delete a queue
wrangler queues delete <queue-name>

# Publish a message to a queue
wrangler queues publish <queue-name> '{"key": "value"}'
```

## 7. Testing

### 7.1 Test Structure

Tests are organized by service and package, with each having its own `tests` directory:

```
services/dome-api/
├── src/
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

### 7.2 Running Tests

To run all tests:

```bash
just test
```

To run tests for a specific package:

```bash
just test-pkg <package-name>
```

To run tests with coverage:

```bash
just test-coverage
```

### 7.3 Writing Tests

Follow these guidelines when writing tests:

1. **Unit tests** should test individual functions and components in isolation.
2. **Integration tests** should test the interaction between multiple components.
3. **End-to-end tests** should test the entire flow from user input to system response.
4. **Use mocks and stubs** to isolate the code being tested.
5. **Test edge cases and error conditions** in addition to the happy path.

Example test:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { myFunction } from '../src/myModule';

describe('myFunction', () => {
  it('should return the expected result', () => {
    // Arrange
    const input = 'test';
    const expected = 'TEST';

    // Act
    const result = myFunction(input);

    // Assert
    expect(result).toBe(expected);
  });

  it('should handle errors', () => {
    // Arrange
    const input = null;

    // Act & Assert
    expect(() => myFunction(input)).toThrow('Invalid input');
  });
});
```

## 8. Debugging

### 8.1 Local Debugging

When running a service locally with `just dev <service-name>`, you can debug using:

1. **Console logs**: Add `console.log()` statements to your code.
2. **Wrangler logs**: View logs in the terminal where the service is running.
3. **Browser DevTools**: Use the browser's developer tools for frontend debugging.

### 8.2 Production Debugging

For debugging in production:

1. **Wrangler tail**: View logs from a deployed worker:

   ```bash
   wrangler tail <service-name>
   ```

2. **Cloudflare Dashboard**: View logs and metrics in the Cloudflare dashboard.

3. **Structured Logging**: Use the structured logging system to filter and analyze logs.

## 9. Documentation

### 9.1 Code Documentation

Document your code using JSDoc comments:

```typescript
/**
 * Calculates the sum of two numbers.
 *
 * @param a - The first number
 * @param b - The second number
 * @returns The sum of a and b
 */
function add(a: number, b: number): number {
  return a + b;
}
```

### 9.2 Project Documentation

Update project documentation when making significant changes:

1. **Service Documentation**: Update the service documentation in `docs/services/`.
2. **API Documentation**: Update the API documentation in `docs/api/`.
3. **Architecture Documentation**: Update architecture documentation if your changes affect the system architecture.
4. **Guides**: Update guides if your changes affect development workflows or processes.

## 10. Continuous Integration and Deployment

### 10.1 CI Pipeline

The CI pipeline runs on every push to the main branch and on pull requests. It includes:

1. **Dependency Installation**: Installing all dependencies.
2. **Type Checking**: Verifying TypeScript types.
3. **Linting**: Checking code style and quality.
4. **Testing**: Running all tests.
5. **Building**: Building all packages and services.
6. **Deployment Validation**: Validating deployment with `wrangler deploy --dry-run`.

### 10.2 CD Pipeline

The CD pipeline runs on merges to the main branch. It includes:

1. **All CI Steps**: Running all CI steps.
2. **Deployment**: Deploying services to the appropriate environment.
3. **Post-Deployment Verification**: Verifying the deployment with smoke tests.

### 10.3 Deployment Environments

The project supports multiple deployment environments:

1. **Development**: For testing during development.
2. **Staging**: For pre-production testing.
3. **Production**: For live, user-facing services.

To deploy to a specific environment:

```bash
just deploy-env <service-name> <environment>
```

## 11. Best Practices

### 11.1 Code Quality

1. **Follow the style guide**: Adhere to the project's coding standards.
2. **Write clean, readable code**: Use meaningful variable and function names.
3. **Keep functions small and focused**: Each function should do one thing well.
4. **Write comprehensive tests**: Aim for high test coverage.
5. **Document your code**: Use JSDoc comments for functions and classes.

### 11.2 Performance

1. **Optimize for edge computing**: Be mindful of the constraints of Cloudflare Workers.
2. **Minimize dependencies**: Only use dependencies when necessary.
3. **Use efficient algorithms and data structures**: Consider time and space complexity.
4. **Cache expensive operations**: Use KV or other caching mechanisms.
5. **Monitor performance metrics**: Keep an eye on response times and resource usage.

### 11.3 Security

1. **Validate all inputs**: Never trust user input.
2. **Use proper authentication and authorization**: Ensure only authorized users can access resources.
3. **Handle sensitive data carefully**: Never log sensitive information.
4. **Follow the principle of least privilege**: Only grant the permissions that are necessary.
5. **Keep dependencies up to date**: Regularly update dependencies to fix security vulnerabilities.

## 12. Troubleshooting Common Issues

### 12.1 pnpm Issues

If you encounter issues with pnpm:

1. **Clear the pnpm cache**:

   ```bash
   pnpm store prune
   ```

2. **Reinstall dependencies**:
   ```bash
   rm -rf node_modules
   pnpm install
   ```

### 12.2 Wrangler Issues

If you encounter issues with Wrangler:

1. **Check Wrangler version**:

   ```bash
   wrangler --version
   ```

2. **Update Wrangler**:

   ```bash
   npm install -g wrangler@latest
   ```

3. **Check Wrangler configuration**:
   Verify that your `wrangler.toml` file is correctly configured.

### 12.3 Deployment Issues

If you encounter issues with deployment:

1. **Check for errors in the CI/CD pipeline**.
2. **Verify that all required environment variables are set**.
3. **Check that all required Cloudflare resources are properly configured**.
4. **Try deploying with verbose logging**:
   ```bash
   wrangler deploy --verbose
   ```

### 12.4 Environment Variable Validation

Services validate their configuration using `loadEnv` from `@dome/common`. Define
a Zod schema in `services/<service>/src/config/env.ts` and call `loadEnv` in the
service constructor. This replaces ad-hoc checks like `if (!env.AUTH_DB)` and
handles comma-separated lists via schema transforms.

## 13. Conclusion

Following this development workflow will help ensure a smooth and efficient development process for the Dome project. If you have any questions or suggestions for improving this workflow, please reach out to the team or submit a pull request to update this guide.
