# GitHub Ingestor Service

This service is responsible for ingesting content from GitHub repositories into the Dome platform. It provides a standardized way to fetch, process, and store GitHub content for use by other services.

## Architecture

The GitHub Ingestor follows a modular architecture designed for extensibility and maintainability:

### Core Components

- **Base Ingestor Interface**: Defines a common contract for all content ingestors (GitHub, Notion, Linear, etc.)
- **GitHub Ingestor Implementation**: Implements the base interface for GitHub-specific functionality
- **Webhook Handling**: Processes GitHub webhook events to trigger ingestion
- **Queue Processing**: Handles asynchronous ingestion tasks
- **Scheduled Sync**: Periodically syncs repositories to ensure content is up-to-date
- **RPC Interface**: Provides methods for other services to interact with the ingestor

### Directory Structure

```
services/github-ingestor/
├── src/
│   ├── index.ts                 # Main entry point
│   ├── types.ts                 # Type definitions
│   ├── cron/                    # Scheduled tasks
│   ├── db/                      # Database schema and migrations
│   ├── github/                  # GitHub-specific utilities
│   ├── ingestors/               # Ingestor implementations
│   │   ├── base.ts              # Base ingestor interface
│   │   └── github/              # GitHub ingestor implementation
│   ├── queue/                   # Queue processing
│   ├── rpc/                     # RPC interface
│   ├── services/                # Service implementations
│   ├── utils/                   # Utility functions
│   │   ├── logging.ts           # Logging utilities
│   │   ├── metrics.ts           # Metrics collection
│   │   ├── polyfills.ts         # Environment polyfills
│   │   └── wrap.ts              # Function wrapper for logging/metrics
│   └── webhook/                 # Webhook handling
└── tests/                       # Tests
```

## Ingestor Interface

The base ingestor interface (`src/ingestors/base.ts`) defines a common contract that all content ingestors must implement. This ensures consistent behavior and makes it easy to add new content sources in the future.

Key interfaces:

- `ContentMetadata`: Common metadata across all providers
- `ContentItem`: Content with metadata
- `IngestionOptions`: Options for ingestion
- `IngestionResult`: Result of ingestion
- `Ingestor`: Base interface for all ingestors
- `BaseIngestor`: Abstract implementation with common functionality

## Adding a New Ingestor

To add a new content source (e.g., Notion, Linear), follow these steps:

1. Create a new directory under `src/ingestors/` for the new provider
2. Implement the `Ingestor` interface or extend the `BaseIngestor` class
3. Add provider-specific utilities under a new directory (e.g., `src/notion/`)
4. Update the webhook handler if the provider supports webhooks
5. Add queue processing for the new provider
6. Implement RPC methods for the new provider
7. Add tests for the new implementation

### Example: Implementing a Notion Ingestor

```typescript
import { BaseIngestor, ContentItem, ContentMetadata, IngestionOptions, IngestionResult } from '../base';

export class NotionIngestor extends BaseIngestor {
  // Implement required methods from BaseIngestor
  getProviderName(): string {
    return 'notion';
  }
  
  getProviderType(): string {
    return 'document';
  }
  
  async testConnection(): Promise<boolean> {
    // Implement Notion-specific connection test
  }
  
  async ingest(options: IngestionOptions): Promise<IngestionResult> {
    // Implement Notion-specific ingestion logic
  }
  
  async ingestItem(itemId: string, options?: IngestionOptions): Promise<ContentItem | null> {
    // Implement Notion-specific item ingestion
  }
  
  async listItems(options?: IngestionOptions): Promise<ContentMetadata[]> {
    // Implement Notion-specific item listing
  }
}
```

## Error Handling and Logging

The service uses a standardized approach to error handling and logging:

- All functions should use the `wrap` utility to ensure consistent logging and metrics
- Errors should be caught and logged with appropriate context
- Metrics should be collected for all operations
- Use the common logging package (`@dome/logging`) for consistency across services

Example:

```typescript
import { wrap } from '../utils/wrap';
import { getLogger } from '@dome/logging';

async function processItem(item: ContentItem): Promise<void> {
  return wrap({ operation: 'processItem', itemId: item.metadata.id }, async () => {
    try {
      // Process the item
      getLogger().info({ item }, 'Processing item');
      
      // Return the result
      return result;
    } catch (error) {
      getLogger().error({ error, item }, 'Failed to process item');
      throw error;
    }
  });
}
```

## Deployment

The service is deployed as a Cloudflare Worker. Key considerations:

- Environment variables are accessed through the `env` object, not `process.env`
- Use polyfills for APIs not available in the Cloudflare Workers runtime
- Avoid using Node.js-specific APIs
- Initialize services in the constructor to ensure proper setup

## Testing

The service includes several types of tests:

- Unit tests for individual components
- Integration tests for service interactions
- E2E tests for complete workflows
- Deployment verification tests

Run tests with:

```bash
pnpm test
```

## Metrics and Monitoring

The service collects metrics for all operations using the common metrics package. Key metrics:

- Ingestion counts (processed, ingested, skipped, failed)
- Processing times
- Error counts
- API rate limit usage
- Queue processing statistics

These metrics are available in the monitoring dashboard.