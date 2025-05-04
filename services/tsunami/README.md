# Tsunami Service

This service is responsible for ingesting content from external sources (like GitHub repositories and Notion workspaces) and storing it in the Silo service for further processing, embedding, and retrieval.

## Supported Content Sources

Tsunami currently supports the following content sources:

### GitHub Repositories

Ingest code and documentation from GitHub repositories. See the [GitHub Repository Registration](#register-a-github-repository) section for details.

### Notion Workspaces

Ingest documents, databases, and other content from Notion workspaces. The Notion integration supports both API key and OAuth authentication methods. See the [Notion Integration](./docs/NOTION_INTEGRATION.md) documentation for detailed setup instructions and [API_NOTION.md](./docs/API_NOTION.md) for API details.

## Recent Changes: Multi-User Sync Plans

We've updated the Tsunami service to avoid duplicate durable objects and sync plans per resource. This means that if multiple users register the same GitHub repository, they will share the same sync plan and durable object, which prevents duplicate indexing of the same data.

### Key Changes

1. **Database Schema**: Updated the sync_plans table to store multiple user IDs per resource

   - Changed from a single `userId` field to a `userIds` array stored as JSON
   - Added a unique constraint on the `resourceId` field

2. **ResourceObject**: Updated to support multiple users

   - Added a `userIds` array to the ResourceObject configuration
   - Added an `addUser` method to add a user to the ResourceObject
   - Added a fetch handler to handle HTTP requests to the Durable Object

3. **SyncPlanService**: Created a generic service for sync plan management
   - Provides methods to find or create sync plans
   - Adds users to existing sync plans
   - Gets durable objects for resources
   - Initializes or syncs resources

### Migration

If you have existing sync plans in the database, you'll need to run the migration script to convert them to the new schema:

```bash
# Run the migration script
wrangler dev services/tsunami/scripts/run-migration.ts
```

The migration script will:

1. Find all existing sync plans
2. Convert the `userId` field to a `userIds` array
3. Update the sync plans in the database

### API Endpoints

#### Register a GitHub Repository

```http
POST /resource/github
Content-Type: application/json

{
  "userId": "user123",
  "owner": "dome",
  "repo": "tsunami",
  "cadence": "PT1H"
}
```

This endpoint will:

1. Check if a sync plan already exists for the repository
2. If it exists, add the user to the existing sync plan
3. If it doesn't exist, create a new sync plan
4. Initialize or sync the resource

The response will indicate whether the repository was newly registered or already existed:

```json
{
  "success": true,
  "id": "01H1G2J3K4L5M6N7P8Q9R0S1T2",
  "resourceId": "dome/tsunami",
  "message": "GitHub repository dome/tsunami registered for syncing"
}
```

or

```json
{
  "success": true,
  "id": "01H1G2J3K4L5M6N7P8Q9R0S1T2",
  "resourceId": "dome/tsunami",
  "message": "GitHub repository dome/tsunami already registered, added user to existing sync plan"
}
```

## Architecture

The Tsunami service uses Durable Objects to manage the state and synchronization of external content sources. Each Durable Object corresponds to a single external resource (e.g., a GitHub repository) and maintains its sync state.

### Components

- **ResourceObject**: A Durable Object that manages the state and synchronization of an external content source
- **SyncPlanService**: A service that manages sync plans and resource objects
- **Providers**: Implementations of the Provider interface for different content sources:
  - **GitHub**: Ingests content from GitHub repositories
  - **Notion**: Ingests content from Notion workspaces
- **Database**: A D1 database that stores sync plans and their state

## Notion Integration

The Notion integration allows you to ingest content from Notion workspaces into your knowledge base. Key features include:

- Connect to Notion workspaces using API keys or OAuth
- Automatically sync content on a configurable schedule
- Filter content based on customizable rules
- Track sync history and status
- Convert Notion-specific formatting to standard text

### Registering a Notion Workspace

```http
POST /resource/notion
Content-Type: application/json

{
  "userId": "user123",
  "workspaceId": "your_workspace_id",
  "cadence": "PT1H"
}
```

This endpoint will:

1. Check if a sync plan already exists for the workspace
2. If it exists, add the user to the existing sync plan
3. If it doesn't exist, create a new sync plan
4. Initialize or sync the workspace

The response will indicate whether the workspace was newly registered or already existed:

```json
{
  "success": true,
  "id": "01H1G2J3K4L5M6N7P8Q9R0S1T2",
  "resourceId": "your_workspace_id",
  "message": "Notion workspace registered for syncing"
}
```

For detailed documentation on the Notion integration, see:

- [Notion Integration Guide](./docs/NOTION_INTEGRATION.md)
- [Notion API Documentation](./docs/API_NOTION.md)
