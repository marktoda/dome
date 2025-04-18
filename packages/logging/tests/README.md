# Testing @dome/logging

This directory contains test setup files for the @dome/logging package.

## Setup

The `setup.js` file provides mocks for the Cloudflare Workers environment and console methods to facilitate testing.

## Running Tests

To run the tests:

```bash
# From the package directory
pnpm test

# With coverage
pnpm test:coverage

# In watch mode
pnpm test:watch
```

## Test Files

The test files are located in the `src` directory alongside the source files they test.
