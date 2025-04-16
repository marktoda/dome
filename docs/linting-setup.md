# Linting Setup

This document describes the linting configuration for the Communicator Cloudflare monorepo.

## Overview

The project uses ESLint for linting TypeScript code across all services and packages. A standardized configuration is applied throughout the monorepo to ensure consistent code quality and style.

## Configuration Structure

- Root `.eslintrc.js`: Base configuration that all services extend
- Service-specific `.eslintrc.js`: Extends the root configuration with service-specific overrides
- `.eslintignore`: Specifies files and directories to be ignored by ESLint
- `.prettierrc.js`: Configuration for Prettier code formatting

## Linting Rules

The ESLint configuration includes:

- TypeScript-specific rules via `@typescript-eslint`
- Best practices for modern JavaScript
- Rules that enforce consistent code style
- Error prevention rules

## Running Linting

You can run linting using the following commands:

### Using pnpm

```bash
# Lint all packages
pnpm run lint

# Lint all packages and fix issues automatically
pnpm run lint:fix

# Lint a specific package
pnpm --filter <package-name> lint

# Lint a specific package and fix issues automatically
pnpm --filter <package-name> lint -- --fix
```

### Using just

```bash
# Lint all packages
just lint

# Lint all packages and fix issues automatically
just lint-fix

# Lint a specific package
just lint-pkg <package-name>

# Lint a specific package and fix issues automatically
just lint-fix-pkg <package-name>
```

## Adding ESLint to a New Service

When creating a new service, make sure to:

1. Add ESLint dependencies to the service's `package.json`:

   ```json
   "devDependencies": {
     "@typescript-eslint/eslint-plugin": "^5.57.1",
     "@typescript-eslint/parser": "^5.57.1",
     "eslint": "^8.38.0"
   }
   ```

2. Add a lint script to the service's `package.json`:

   ```json
   "scripts": {
     "lint": "eslint src --ext .ts,.tsx"
   }
   ```

3. Create a `.eslintrc.js` file in the service directory that extends the root configuration:
   ```js
   module.exports = {
     extends: ['../../.eslintrc.js'],
     parserOptions: {
       project: './tsconfig.json',
       tsconfigRootDir: __dirname,
     },
     rules: {
       // Service-specific overrides can be added here
     },
   };
   ```

## Customizing Rules

To customize rules for a specific service, modify the service's `.eslintrc.js` file:

```js
module.exports = {
  extends: ['../../.eslintrc.js'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Override specific rules
    '@typescript-eslint/no-explicit-any': 'off',
    'no-console': 'off',
  },
};
```
