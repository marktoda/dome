# Tsunami Service

Tsunami is a service that ingests content from external sources (like GitHub repositories) and stores it in the Silo service for further processing, embedding, and retrieval.

## Features

- GitHub repository ingestion
- Scheduled syncing of repositories
- Incremental updates (only fetches changes since last sync)
- Durable Object-based sync state tracking

## Architecture

Tsunami uses Cloudflare Workers with Durable Objects to manage the state of each repository sync. The service consists of:

1. **Main Worker**: Handles scheduled triggers and routes requests to the appropriate Durable Objects
2. **ResourceObject**: A Durable Object that manages the sync state for a specific repository
3. **Providers**: Implementations for different content sources (currently GitHub)
4. **SiloService**: Client for storing content in the Silo service

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

3. Add repositories to the sync_plan table:

```sql
INSERT INTO sync_plan (id, user_id, provider, resource_id, cadence, cursor, next_run)
VALUES (
  'unique-id', 
  'user-id', 
  'github', 
  'owner/repo', 
  'PT1H', 
  NULL, 
  unixepoch()
);
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

1. The scheduled cron trigger runs every 15 minutes
2. It queries the sync_plan table for repositories that need to be synced
3. For each repository, it:
   - Gets the ResourceObject Durable Object for that repository
   - Triggers a sync operation
   - Updates the next_run time in the sync_plan table
4. The ResourceObject:
   - Loads its configuration
   - Creates the appropriate provider (GitHub)
   - Calls the provider's pull method to get new content
   - Uploads the content to Silo
   - Updates its internal state with the new cursor (commit SHA)
   - Sets an alarm for the next sync

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

### sync_plan Table

| Column      | Type    | Description                                |
|-------------|---------|--------------------------------------------|
| id          | TEXT    | Primary key (ULID)                         |
| user_id     | TEXT    | User ID who owns this sync plan            |
| provider    | TEXT    | Provider type (e.g., 'github')             |
| resource_id | TEXT    | Resource identifier (e.g., 'owner/repo')   |
| cadence     | TEXT    | Sync frequency (ISO-8601 duration)         |
| cursor      | TEXT    | Provider-specific cursor for incremental updates |
| next_run    | INTEGER | Next scheduled run time (epoch ms)         |