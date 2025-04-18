# Dome Platform Logging Tests

This directory contains tests for the Dome platform logging system. These tests are designed to validate the core functionality of the logging system and ensure it works correctly in Cloudflare Workers environments.

## Test Structure

The tests are organized as follows:

### 1. Factory Tests (`logging/factory.test.ts`)

These tests validate the core logging SDK functionality:

- **Logger Creation**: Tests that loggers can be created with different configurations
- **Log Level Filtering**: Verifies that log level filtering works correctly (debug, info, warn, error)
- **Error Serialization**: Tests that errors are properly serialized in log messages
- **Circular Reference Handling**: Ensures that circular references in log data are handled gracefully

### 2. Hono Middleware Tests (`logging/honoMiddleware.test.ts`)

These tests validate the Hono middleware functionality:

- **Request ID Generation**: Tests that request IDs are generated and propagated correctly
- **Request ID Propagation**: Verifies that request IDs are included in response headers
- **Custom Request ID Headers**: Tests that custom request ID header names work correctly
- **Error Handling**: Ensures that errors are properly caught, logged, and rethrown

## Running the Tests

To run the tests:

```bash
cd packages/common
pnpm test
```

## Manual Verification Script

A script for manual verification of logs in Cloudflare Logs Engine is provided at `scripts/verify-logging.js`. This script:

1. Makes a series of requests to a test endpoint
2. Generates logs with different paths and request IDs
3. Optionally includes error requests
4. Provides SQL queries to verify the logs in Cloudflare Logs Engine

To use the script:

```bash
node scripts/verify-logging.js --endpoint http://localhost:8787 --requests 10
```

## Troubleshooting

If you encounter issues with the tests:

1. Ensure the Cloudflare Worker environment is properly mocked in `tests/setup.js`
2. Check that the `process.env` polyfill is working correctly
3. Verify that the logger factory can handle environments where `process` is not defined

## Fixing the "process is not defined" Error

The logging system has been updated to handle environments where `process` is not defined (like Cloudflare Workers). The fix involves:

1. Adding safe access to `process.env` with fallbacks
2. Using a helper function to safely get environment variables
3. Catching and handling errors when accessing `process.env`

These changes ensure the logging system works correctly in both Node.js and Cloudflare Workers environments.
