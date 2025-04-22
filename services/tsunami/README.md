# Tsunami Service

Tsunami is a service that ingests content from external sources (like GitHub repositories) and stores it in the Silo service for further processing, embedding, and retrieval.

## Features

- GitHub repository ingestion
- Scheduled syncing of repositories
- Incremental updates (only fetches changes since last sync)
- Durable Object-based sync state tracking
- D1 database for sync plan management
- Type-safe database operations with Drizzle ORM
- Sync history tracking

## Architecture

Tsunami uses Cloudflare Workers with Durable Objects to manage the state of each repository sync. The service consists of:

1. **Main Worker**: Handles scheduled triggers and routes requests to the appropriate Durable Objects
2. **ResourceObject**: A Durable Object that manages the sync state for a specific repository
3. **Providers**: Implementations for different content sources (currently GitHub)
4. **SiloService**: Client for storing content in the Silo service
5. **Database Client**: Type-safe Drizzle ORM client for database operations

## GitHub Provider

The GitHub provider fetches content from GitHub repositories and converts it to a format suitable for storage in Silo. It supports:

- Fetching commits since a specific cursor (commit SHA)
- Retrieving file changes from each commit
- Converting file content to Silo-compatible format
- Tracking the sync state to enable incremental updates

### Configuration

To use the GitHub provider, you need to:

1. Set up a GitHub token with appropriate permissions
2. Add the token to your environment variables:
   - For production: Use Wrangler secrets
   - For development: Add to `.dev.vars` file

```bash
# Add GitHub token to Wrangler secrets
wrangler secret put GITHUB_TOKEN
```

3. Register repositories using the API:

```bash
curl -X POST https://tsunami.chatter-9999.workers.dev/resource/github \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-id",
    "owner": "owner",
    "repo": "repo",
    "cadence": "PT1H"
  }'
```

Or use the provided script:

```bash
npx tsx scripts/upload-test-repos.ts
```

### ResourceObject Initialization and Sync Process

#### Initialization

When a new GitHub repository is registered:

1. A new entry is created in the `sync_plan` table with repository details
2. A ResourceObject Durable Object is created with the repository ID as its key
3. The ResourceObject is initialized with configuration:
   - User ID who owns the repository
   - Repository ID (owner/repo)
   - Provider type (GitHub)
   - Sync frequency (cadence)
   - Initial cursor (null to start with all content)
4. The ResourceObject stores this configuration in its durable storage
5. The ResourceObject sets an alarm for the first sync

#### Sync Process

1. When a ResourceObject is initialized, it sets an alarm for the first sync
2. When the alarm fires, the ResourceObject:
   - Loads its configuration
   - Creates the appropriate provider (GitHub)
   - Calls the provider's pull method to get new content
   - Uploads the content to Silo
   - Updates its internal state with the new cursor (commit SHA)
   - Sets an alarm for the next sync based on cadenceSecs
3. This process repeats automatically based on the configured cadence

## Development

### Prerequisites

- Node.js and pnpm
- Wrangler CLI

### Setup

1. Install dependencies:

```bash
pnpm install
```

2. Set up local environment variables:

```bash
# Edit .dev.vars file
GITHUB_TOKEN=your_github_token_here
```

3. Run migrations:

```bash
wrangler d1 execute sync-plan --local --file=./migrations/0000_create_sync_plan.sql
```

### Running Locally

```bash
wrangler dev
```

### Deployment

```bash
wrangler deploy
```

## Database Schema

Tsunami uses a minimal database schema to track repositories for syncing. The detailed sync state is stored in Durable Objects.

### sync_plan Table

| Column        | Type    | Description                                |
|---------------|---------|--------------------------------------------|
| id            | TEXT    | Primary key (ULID)                         |
| user_id       | TEXT    | User ID who owns this sync plan            |
| provider      | TEXT    | Provider type (e.g., 'github')             |
| resource_id   | TEXT    | Resource identifier (e.g., 'owner/repo')   |
| next_run      | INTEGER | Next scheduled run time (epoch ms)         |
| created_at    | INTEGER | Creation timestamp                         |

## Drizzle ORM Integration

Tsunami uses Drizzle ORM for type-safe database operations. The integration includes:

1. **Schema Definition**: Type-safe schema definition in `src/db/schema.ts`
2. **Database Client**: Reusable database client in `src/db/client.ts`
3. **Type-Safe Queries**: All database operations use Drizzle's query builder
4. **Repository Pattern**: Database operations are organized by entity

### Example: Creating a Sync Plan

```typescript
// Using the syncPlanOperations from db/client.ts
await syncPlanOperations.create(db, {
  id: ulid(),
  userId: 'user-id',
  provider: 'github',
  resourceId: 'owner/repo',
  cadenceSecs: 3600,
});
```

### Example: Retrieving Sync History

```typescript
// Using the syncHistoryOperations from db/client.ts
const history = await syncHistoryOperations.getLatestBySyncPlanId(db, syncPlanId, 10);
```

## API Endpoints

### Register GitHub Repository

```
POST /resource/github
```

Request body:
```json
{
  "userId": "user-id",
  "owner": "owner",
  "repo": "repo",
  "cadence": "PT1H"
}
```

### Get Sync History

```
GET /resource/github/:owner/:repo/history
```

Query parameters:
- `limit`: Maximum number of history entries to return (default: 10)

### Direct Durable Object Initialization

This endpoint allows direct initialization of a ResourceObject Durable Object without going through the database. This is useful for testing and development, or as a workaround when the database is not properly configured.

```
POST /do/:resourceId/initialize
```

Request body:
```json
{
  "userId": "anonymous",
  "resourceId": "owner/repo",
  "providerType": "GITHUB",
  "cadenceSecs": 3600,
  "cursor": null
}
```

Example:
```bash
curl -X POST https://tsunami.chatter-9999.workers.dev/do/uniswap/v4-core/initialize \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "anonymous",
    "resourceId": "uniswap/v4-core",
    "providerType": "GITHUB",
    "cadenceSecs": 3600,
    "cursor": null
  }'
```

## Scripts

### Upload Test Repositories

The `scripts/upload-test-repos.ts` script allows you to register test GitHub repositories with the Tsunami service. It supports both the regular API endpoint and direct Durable Object initialization.

```bash
# Install dependencies
npm install -g tsx

# Run the script
tsx scripts/upload-test-repos.ts
```

You can also use the shell wrapper:

```bash
./scripts/upload-repos.sh
```

## Troubleshooting

If you encounter the error "Cannot read properties of undefined (reading 'SYNC_PLAN')" when using the API, it means the D1 database binding is not properly configured. You can use the direct Durable Object initialization route as a workaround:

```
POST /do/:resourceId/initialize
```

Or use the `upload-test-repos.ts` script with the `USE_DIRECT_DO_INITIALIZATION` flag set to `true`.