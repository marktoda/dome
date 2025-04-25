# Setup Guide

This guide provides instructions for setting up the development environment for the Chat RAG Graph solution.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v18 or later)
- **pnpm** (v8 or later)
- **Wrangler CLI** (v3 or later)
- **Git** (v2 or later)

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/your-organization/dome.git
cd dome
```

### 2. Install Dependencies

```bash
pnpm install
```

This will install all dependencies for the monorepo, including the Chat RAG Graph solution.

### 3. Set Up Environment Variables

Create a `.dev.vars` file in the `services/chat-orchestrator` directory:

```bash
cd services/chat-orchestrator
touch .dev.vars
```

Add the following environment variables to the `.dev.vars` file:

```
DOME_API_URL=https://api.dome.cloud
DOME_API_KEY=your-api-key
JWT_SECRET=your-jwt-secret
```

For local development, you can use placeholder values for these variables.

### 4. Set Up Cloudflare D1 Database

Create a local D1 database for development:

```bash
wrangler d1 create chat-orchestrator-dev
```

Note the database ID in the output, and add it to your `wrangler.toml` file:

```toml
[[d1_databases]]
binding = "D1"
database_name = "chat-orchestrator-dev"
database_id = "your-database-id"
```

### 5. Apply Database Migrations

```bash
wrangler d1 execute chat-orchestrator-dev --local --file=./migrations/initial.sql
```

## Local Development

### Start the Development Server

```bash
cd services/chat-orchestrator
pnpm dev
```

This will start the development server using Wrangler, which will:

- Watch for changes to your code
- Automatically restart the server when changes are detected
- Provide a local endpoint for testing

The server will be available at `http://localhost:8787`.

### Testing the API

You can test the API using curl:

```bash
curl -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token" \
  -d '{
    "messages": [
      {"role": "user", "content": "What is the capital of France?"}
    ],
    "options": {
      "enhanceWithContext": true,
      "maxContextItems": 5,
      "includeSourceInfo": true
    }
  }'
```

Or using the provided test client:

```bash
pnpm test:client
```

## Setting Up External Services

The Chat RAG Graph solution integrates with several external services. For development, you can use mock implementations or set up local versions of these services.

### LLM Service

For development, you can use the Cloudflare AI binding with a local mock:

1. Create a mock implementation in `src/services/__mocks__/llmService.ts`:

```typescript
export const LlmService = {
  async analyzeQueryComplexity() {
    return {
      isComplex: false,
      shouldSplit: false,
      reason: 'Query is simple',
    };
  },

  async rewriteQuery(env, query) {
    return `Rewritten: ${query}`;
  },

  async extractToolInput() {
    return { input: 'mock input' };
  },

  async generateResponse() {
    return 'This is a mock response from the LLM service.';
  },

  MODEL: 'mock-model',
};
```

2. Update your test configuration to use the mock:

```typescript
// In vitest.config.ts
export default defineConfig({
  test: {
    // ...
    setupFiles: ['./tests/setup.js'],
  },
});

// In tests/setup.js
import { vi } from 'vitest';

vi.mock('../src/services/llmService');
```

### Vector Database

For development, you can use a local vector database:

1. Create a mock implementation in `src/services/__mocks__/searchService.ts`:

```typescript
export const SearchService = {
  async search() {
    return [
      {
        id: 'doc-1',
        title: 'Sample Document 1',
        body: 'This is the content of sample document 1.',
        metadata: {
          source: 'knowledge-base',
          createdAt: new Date().toISOString(),
          relevanceScore: 0.95,
        },
      },
      {
        id: 'doc-2',
        title: 'Sample Document 2',
        body: 'This is the content of sample document 2.',
        metadata: {
          source: 'knowledge-base',
          createdAt: new Date().toISOString(),
          relevanceScore: 0.85,
        },
      },
    ];
  },

  rankAndFilterDocuments(docs) {
    return docs;
  },

  extractSourceMetadata(docs) {
    return docs.map(doc => ({
      id: doc.id,
      title: doc.title,
      source: doc.metadata.source,
      relevanceScore: doc.metadata.relevanceScore,
    }));
  },
};
```

2. Update your test configuration to use the mock:

```typescript
// In tests/setup.js
vi.mock('../src/services/searchService');
```

## Development Tools

### Code Linting

The project uses ESLint for code linting:

```bash
pnpm lint
```

To automatically fix linting issues:

```bash
pnpm lint:fix
```

### Type Checking

The project uses TypeScript for type checking:

```bash
pnpm typecheck
```

### Testing

The project uses Vitest for testing:

```bash
pnpm test
```

To run tests with coverage:

```bash
pnpm test:coverage
```

### Building

To build the project for production:

```bash
pnpm build
```

## IDE Setup

### VS Code

The repository includes VS Code settings and recommended extensions. To use them:

1. Install the recommended extensions when prompted by VS Code
2. Use the provided workspace settings for consistent formatting and linting

### Other IDEs

For other IDEs, ensure you have:

- TypeScript support
- ESLint integration
- Prettier integration

## Troubleshooting

### Common Issues

#### Wrangler Authentication

If you encounter authentication issues with Wrangler:

```bash
wrangler login
```

#### D1 Database Connection Issues

If you encounter issues connecting to the D1 database:

```bash
wrangler d1 list
```

This will show all your D1 databases. Ensure the database ID in your `wrangler.toml` file matches the ID of your database.

#### Dependency Issues

If you encounter dependency issues:

```bash
pnpm clean
pnpm install
```

This will remove all node_modules directories and reinstall dependencies.

### Getting Help

If you encounter issues not covered in this guide:

1. Check the [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)
2. Check the [Wrangler documentation](https://developers.cloudflare.com/workers/wrangler/)
3. Contact the development team for assistance

## Next Steps

Once you have set up your development environment, you can:

- Review the [Configuration Guide](./configuration.md) to learn how to configure the system
- Explore the [Technical Documentation](../technical/README.md) to understand the system architecture
- Follow the [Testing Guide](./testing.md) to learn how to test your changes
