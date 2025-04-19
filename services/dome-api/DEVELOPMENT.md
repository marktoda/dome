# Dome API Development Guide

This document provides comprehensive instructions for setting up, developing, testing, and deploying the Dome API service.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup and Installation](#setup-and-installation)
- [Local Development](#local-development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

## Prerequisites

Before you begin, ensure you have the following installed:

- [Node.js](https://nodejs.org/) (v18 or later)
- [pnpm](https://pnpm.io/) package manager
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (v4 or later)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) with access to:
  - Workers
  - D1 Database
  - R2 Storage
  - Vectorize
  - Workers AI
  - Service Bindings

## Setup and Installation

### 1. Clone the Repository

```bash
git clone https://github.com/example/dome-cf.git
cd dome-cf
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Set Up Environment Variables

Create a `.dev.vars` file in the `services/dome-api` directory:

```
VERSION=0.1.0
ENVIRONMENT=development
LOG_LEVEL=debug
```

### 4. Set Up Local D1 Database

```bash
# Create a local D1 database for development
cd services/dome-api
wrangler d1 create dome-meta-dev
```

Update your `wrangler.toml` file with the local database ID:

```toml
[[d1_databases]]
binding = "D1_DATABASE"
database_name = "dome-meta-dev"
database_id = "YOUR_LOCAL_DB_ID"
```

### 5. Apply Migrations

```bash
wrangler d1 migrations apply dome-meta-dev --local
```

### 6. Set Up Local R2 Bucket

```bash
# Create a local R2 bucket for development
wrangler r2 bucket create dome-raw-dev
```

## Local Development

### Starting the Development Server

```bash
cd services/dome-api
pnpm dev
```

This will start the Wrangler development server, typically on port 8787.

### Development Workflow

1. **Make code changes**: Edit files in the `src` directory
2. **Automatic reload**: The development server will automatically reload when you save changes
3. **Test API endpoints**: Use tools like [Postman](https://www.postman.com/) or [curl](https://curl.se/) to test API endpoints
4. **Check logs**: Monitor the console for logs and errors

### Working with the Constellation Service

When developing locally, you have two options for working with the Constellation service:

1. **Mock the service**: Create a mock implementation of the Constellation service for local development
2. **Connect to a development instance**: Configure your `wrangler.toml` to connect to a development instance of the Constellation service

#### Option 1: Mock Implementation

Create a mock implementation in your local development environment:

```typescript
// src/services/__mocks__/constellationService.ts
export class MockConstellationService {
  async enqueueEmbedding(env, userId, noteId, text) {
    console.log(`[MOCK] Enqueued embedding for note ${noteId}`);
    return Promise.resolve();
  }

  async embedDirectly(env, userId, noteId, text) {
    console.log(`[MOCK] Embedded note ${noteId} directly`);
    return Promise.resolve();
  }

  async query(env, text, filter, topK = 10) {
    console.log(`[MOCK] Queried for "${text}" with filter`, filter);
    return Promise.resolve([
      // Mock search results
    ]);
  }

  async getStats(env) {
    return Promise.resolve({
      vectors: 100,
      dimension: 384,
    });
  }
}

export const constellationService = new MockConstellationService();
```

#### Option 2: Development Instance

Update your `wrangler.toml` to connect to a development instance:

```toml
# For local development
[dev]
port = 8787

[[services]]
binding = "CONSTELLATION"
service = "constellation-dev"
environment = "development"
```

### Working with D1 Database

You can interact with your local D1 database using the Wrangler CLI:

```bash
# Execute SQL queries
wrangler d1 execute dome-meta-dev --local --command "SELECT * FROM notes"

# Import data
wrangler d1 import dome-meta-dev --local ./data/seed.sql
```

### Working with R2 Storage

You can interact with your local R2 bucket using the Wrangler CLI:

```bash
# List objects
wrangler r2 object list dome-raw-dev

# Upload a file
wrangler r2 object put dome-raw-dev/test.txt --file ./test.txt
```

## Testing

### Running Tests

```bash
# Run all tests
cd services/dome-api
pnpm test

# Run tests in watch mode
pnpm test:watch
```

### Writing Tests

Tests are located in the `tests` directory and use [Jest](https://jestjs.io/) as the test runner.

Example test for a repository:

```typescript
// tests/repositories/noteRepository.test.ts
import { NoteRepository } from '../../src/repositories/noteRepository';
import { createMockEnvironment } from '../utils/mockEnvironment';

describe('NoteRepository', () => {
  let repository: NoteRepository;
  let env: any;

  beforeEach(() => {
    env = createMockEnvironment();
    repository = new NoteRepository();
  });

  it('should create a note', async () => {
    const note = await repository.create(env, {
      userId: 'user-123',
      title: 'Test Note',
      body: 'This is a test note',
      contentType: 'text/plain',
    });

    expect(note).toBeDefined();
    expect(note.id).toBeDefined();
    expect(note.title).toBe('Test Note');
    expect(note.body).toBe('This is a test note');
  });
});
```

### Test Coverage

To generate a test coverage report:

```bash
pnpm test -- --coverage
```

The coverage report will be available in the `coverage` directory.

## Deployment

### Deploying to Staging

```bash
cd services/dome-api
pnpm deploy:staging
```

### Deploying to Production

```bash
cd services/dome-api
pnpm deploy:prod
```

### Deployment Environments

The Dome API service supports multiple deployment environments:

- **Development**: Local development environment
- **Staging**: Pre-production environment for testing
- **Production**: Live environment for end users

Each environment has its own configuration in `wrangler.toml`:

```toml
[env.staging]
vars = { ENVIRONMENT = "staging" }

[[env.staging.services]]
binding = "CONSTELLATION"
service = "constellation"
environment = "staging"

[env.production]
vars = { ENVIRONMENT = "production" }

[[env.production.services]]
binding = "CONSTELLATION"
service = "constellation"
environment = "production"
```

## Environment Variables

The Dome API service uses the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `VERSION` | API version | `0.1.0` |
| `ENVIRONMENT` | Deployment environment | `development` |
| `LOG_LEVEL` | Logging level | `debug` |

These variables can be set in `.dev.vars` for local development or in the Cloudflare dashboard for deployed environments.

## Troubleshooting

### Common Issues

#### 1. Embedding Not Working

**Symptoms**:
- Notes are not being embedded
- Search returns no results
- `embeddingStatus` remains "pending"

**Solutions**:
- Check if the Constellation service is running
- Verify the service binding is correctly configured in `wrangler.toml`
- Check the queue depth for embedding jobs
- Look for errors in the Cloudflare Workers logs

#### 2. Search Not Returning Expected Results

**Symptoms**:
- Search returns no results or unexpected results
- Search is slow

**Solutions**:
- Verify the note has been embedded (check Vectorize index)
- Check if the search query is properly formatted
- Ensure metadata filters are correctly applied
- Check the Constellation service logs for errors

#### 3. File Uploads Failing

**Symptoms**:
- File uploads return errors
- Files are not being stored

**Solutions**:
- Check R2 bucket configuration
- Verify file size limits (max 100MB)
- Check file content type handling
- Look for errors in the Cloudflare Workers logs

#### 4. Database Errors

**Symptoms**:
- API returns 500 errors
- Database operations fail

**Solutions**:
- Check D1 database configuration
- Verify migrations have been applied
- Check for schema mismatches
- Look for errors in the Cloudflare Workers logs

### Debugging Techniques

#### 1. Enable Debug Logging

Set the `LOG_LEVEL` environment variable to `debug`:

```
LOG_LEVEL=debug
```

#### 2. Check Cloudflare Workers Logs

```bash
wrangler tail dome-api
```

#### 3. Test Endpoints Locally

Use tools like [Postman](https://www.postman.com/) or [curl](https://curl.se/) to test API endpoints locally:

```bash
curl -X GET "http://localhost:8787/health" -H "x-user-id: user-123"
```

#### 4. Inspect Database

```bash
wrangler d1 execute dome-meta-dev --local --command "SELECT * FROM notes"
```

#### 5. Check Queue Status

Monitor the queue depth and processing status in the Cloudflare dashboard.

## Best Practices

### Code Style

- Follow the established code style in the repository
- Use ESLint and Prettier for code formatting
- Write meaningful comments and documentation

### Error Handling

- Use the error handling middleware for consistent error responses
- Log errors with appropriate context
- Return user-friendly error messages

### Performance

- Use asynchronous operations where possible
- Optimize database queries
- Use the Constellation service for embedding and search operations
- Implement caching where appropriate

### Security

- Validate user input
- Use proper authentication and authorization
- Follow the principle of least privilege
- Keep dependencies up to date

### Testing

- Write unit tests for all components
- Use mock objects for external dependencies
- Test error handling and edge cases
- Maintain high test coverage