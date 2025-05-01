# Notion Ingestor Implementation

This document provides a comprehensive overview of the Notion ingestor system implementation, detailing its architecture, components, API reference, and usage examples.

## Overview

The Notion ingestor system is a specialized component within the Dome platform that enables users to connect their Notion workspaces and synchronize content into the platform. It provides a seamless integration with Notion's API, allowing for automated content ingestion, transformation, and storage. The system handles authentication via OAuth, periodic content synchronization, and content transformation from Notion's proprietary format to standardized formats used within the Dome ecosystem.

Key capabilities include:
- OAuth-based authentication with Notion workspaces
- Periodic and on-demand content synchronization
- Intelligent content filtering and transformation
- Detailed sync history tracking
- User-specific workspace access management

## Architecture

The Notion ingestor system follows a microservices architecture pattern and is distributed across multiple services:

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│                 │      │                 │      │                 │
│    Dome API     │─────▶│    Tsunami      │─────▶│      Silo       │
│                 │      │                 │      │                 │
└─────────────────┘      └─────────────────┘      └─────────────────┘
        │                        │
        │                        │
        ▼                        ▼
┌─────────────────┐      ┌─────────────────┐
│                 │      │                 │
│  Notion OAuth   │      │  Notion API     │
│                 │      │                 │
└─────────────────┘      └─────────────────┘
```

### Service Responsibilities

1. **Dome API Service**
   - Exposes REST endpoints for Notion workspace registration and management
   - Handles user authentication and authorization
   - Provides API for triggering syncs and viewing history

2. **Tsunami Service**
   - Manages the content ingestion pipeline
   - Implements the Notion provider for content extraction
   - Handles OAuth token exchange and secure storage
   - Schedules periodic syncs and maintains sync history
   - Transforms Notion content into standardized formats

3. **Silo Service**
   - Stores and indexes the ingested content
   - Provides search capabilities across ingested content

## Components

### Tsunami Service Components

#### Notion Provider (`services/tsunami/src/providers/notion/index.ts`)

The Notion Provider is the core component responsible for pulling content from Notion workspaces. It implements the Provider interface and handles:

- Content extraction from Notion pages and databases
- Metadata generation for each content piece
- Content filtering based on configured rules
- Error handling and metrics tracking

```typescript
export class NotionProvider implements Provider {
  // Pulls content from Notion workspaces
  async pull({ userId, resourceId, cursor }: PullOpts): Promise<PullResult> {
    // Implementation details...
  }
}
```

#### Notion Client (`services/tsunami/src/providers/notion/client.ts`)

The Notion Client handles direct communication with the Notion API, including:

- Authentication with API keys or OAuth tokens
- Rate limiting and retry logic
- Error handling and logging
- Content fetching and pagination

```typescript
export class NotionClient {
  // Fetches updated pages in a workspace
  async getUpdatedPages(workspaceId: string, cursor: string | null): Promise<NotionPage[]>
  
  // Gets content for a specific page
  async getPageContent(pageId: string): Promise<string>
  
  // Creates a client instance for a specific user
  async forUser(userId: string, workspaceId: string): Promise<NotionClient>
}
```

#### Notion Auth Manager (`services/tsunami/src/providers/notion/auth.ts`)

The Auth Manager handles OAuth integration with Notion, including:

- OAuth URL generation for authorization
- Token exchange and secure storage
- User-specific token management

```typescript
export class NotionAuthManager {
  // Generates OAuth authorization URL
  getAuthUrl(state: string): string
  
  // Exchanges authorization code for access token
  async exchangeCodeForToken(code: string): Promise<{
    accessToken: string;
    workspaceId: string;
    workspaceName: string;
    botId: string;
  }>
  
  // Stores and retrieves user tokens
  async storeUserToken(userId: string, workspaceId: string, token: string): Promise<void>
  async getUserToken(userId: string, workspaceId: string): Promise<string | null>
}
```

#### Notion Utilities (`services/tsunami/src/providers/notion/utils.ts`)

Utility functions for transforming Notion-specific data structures:

- Content extraction from Notion blocks
- Metadata creation for standardized format
- Content categorization and MIME type determination
- Filtering logic for content selection

```typescript
// Creates metadata for Notion content
export function createNotionMetadata(
  workspaceId: string,
  pageId: string,
  updatedAt: string,
  title: string,
  sizeBytes: number,
): DomeMetadata

// Converts Notion blocks to text
export function blocksToText(blocks: NotionBlock[]): string

// Determines if a page should be filtered out
export function shouldIgnorePage(page: NotionPage): boolean
```

### Dome API Service Integration

#### Notion Controller (`services/dome-api/src/controllers/notionController.ts`)

The Notion Controller exposes the API endpoints for Notion integration:

- Workspace registration and management
- OAuth configuration
- History retrieval
- Sync triggering

```typescript
export class NotionController {
  // Registers a Notion workspace
  async registerNotionWorkspace(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>)
  
  // Gets history for a workspace
  async getNotionWorkspaceHistory(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>)
  
  // Triggers a sync for a workspace
  async triggerNotionWorkspaceSync(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>)
  
  // Configures OAuth
  async configureNotionOAuth(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>)
  
  // Gets OAuth URL
  async getNotionOAuthUrl(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>)
}
```

#### API Routes (`services/dome-api/src/index.ts`)

The API routes for Notion integration:

```typescript
// Notion workspace registration and management
contentRouter.post('/notion', async (c) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.registerNotionWorkspace(c);
});

// Get Notion workspace history
contentRouter.get('/notion/:workspaceId/history', async (c) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.getNotionWorkspaceHistory(c);
});

// Trigger Notion workspace sync
contentRouter.post('/notion/:workspaceId/sync', async (c) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.triggerNotionWorkspaceSync(c);
});

// Notion OAuth configuration
contentRouter.post('/notion/oauth', async (c) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.configureNotionOAuth(c);
});

// Get Notion OAuth URL
contentRouter.get('/notion/oauth/url', async (c) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.getNotionOAuthUrl(c);
});
```

#### Tsunami Client (`services/tsunami/src/client/client.ts`)

The Tsunami Client provides methods for interacting with the Tsunami service:

```typescript
export class TsunamiClient implements TsunamiService {
  // Registers a Notion workspace
  async registerNotionWorkspace(
    workspaceId: string,
    userId?: string,
    cadenceSecs: number = 3600
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }>
  
  // Gets history for a Notion workspace
  async getNotionWorkspaceHistory(workspaceId: string, limit: number = 10): Promise<{
    workspaceId: string;
    resourceId: string;
    history: unknown[];
  }>
}
```

### Testing Coverage

The Notion ingestor system includes comprehensive test coverage:

1. **Unit Tests**
   - `services/tsunami/tests/providers/notion/client.test.ts` - Tests for the Notion client
   - `services/tsunami/tests/providers/notion/auth.test.ts` - Tests for the auth manager
   - `services/tsunami/tests/providers/notion/utils.test.ts` - Tests for utility functions

2. **Integration Tests**
   - `services/tsunami/tests/providers/notion/integration.test.ts` - Tests for the Notion provider
   - `services/dome-api/tests/routes/notion.test.ts` - Tests for the API routes
   - `services/dome-api/tests/controllers/notionController.test.ts` - Tests for the controller

3. **Fixtures**
   - `services/tsunami/tests/providers/notion/fixtures.ts` - Test fixtures for Notion objects
   - `services/dome-api/tests/fixtures/notion.ts` - Test fixtures for API requests/responses

## API Reference

### Notion Integration Endpoints

| Endpoint | Method | Description | Request Body | Response |
|----------|--------|-------------|-------------|----------|
| `/content/notion` | POST | Register a Notion workspace | `{ workspaceId: string, userId?: string, cadence?: string }` | `{ success: true, id: string, resourceId: string, wasInitialised: boolean }` |
| `/content/notion/:workspaceId/history` | GET | Get workspace sync history | - | `{ success: true, workspaceId: string, resourceId: string, history: Array }` |
| `/content/notion/:workspaceId/sync` | POST | Trigger workspace sync | - | `{ success: true, message: string, workspaceId: string }` |
| `/content/notion/oauth` | POST | Configure OAuth | `{ code: string, redirectUri: string, userId?: string }` | `{ success: true, message: string, userId?: string }` |
| `/content/notion/oauth/url` | GET | Get OAuth URL | `{ redirectUri: string, state?: string }` | `{ success: true, url: string }` |

### Request/Response Examples

#### Register Notion Workspace

Request:
```json
POST /content/notion
{
  "workspaceId": "workspace-123",
  "userId": "user-456",
  "cadence": "PT1H"
}
```

Response:
```json
{
  "success": true,
  "id": "sync-plan-789",
  "resourceId": "workspace-123",
  "wasInitialised": true
}
```

#### Get Workspace History

Request:
```
GET /content/notion/workspace-123/history?limit=5
```

Response:
```json
{
  "success": true,
  "workspaceId": "workspace-123",
  "resourceId": "workspace-123",
  "history": [
    {
      "id": "history-1",
      "syncPlanId": "sync-plan-789",
      "timestamp": "2025-04-30T10:00:00Z",
      "status": "success",
      "pagesProcessed": 15,
      "pagesFiltered": 3
    },
    // Additional history entries...
  ]
}
```

#### Trigger Workspace Sync

Request:
```
POST /content/notion/workspace-123/sync
```

Response:
```json
{
  "success": true,
  "message": "Notion workspace sync has been triggered",
  "workspaceId": "workspace-123"
}
```

#### Configure OAuth

Request:
```json
POST /content/notion/oauth
{
  "code": "notion-oauth-code-123",
  "redirectUri": "https://dome.example.com/oauth/callback",
  "userId": "user-456"
}
```

Response:
```json
{
  "success": true,
  "message": "Notion OAuth configured successfully",
  "userId": "user-456"
}
```

#### Get OAuth URL

Request:
```json
GET /content/notion/oauth/url
{
  "redirectUri": "https://dome.example.com/oauth/callback",
  "state": "random-state-123"
}
```

Response:
```json
{
  "success": true,
  "url": "https://api.notion.com/v1/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=https%3A%2F%2Fdome.example.com%2Foauth%2Fcallback&response_type=code&state=random-state-123"
}
```

## Usage Examples

### Registering a Notion Workspace

```typescript
// Using the Dome API client
const response = await domeApiClient.post('/content/notion', {
  workspaceId: 'workspace-123',
  userId: 'user-456',
  cadence: 'PT1H' // 1 hour sync interval
});

if (response.success) {
  console.log(`Workspace registered with sync plan ID: ${response.id}`);
}
```

### OAuth Authorization Flow

```typescript
// Step 1: Get the OAuth URL
const urlResponse = await domeApiClient.get('/content/notion/oauth/url', {
  redirectUri: 'https://dome.example.com/oauth/callback',
  state: 'random-state-123'
});

// Step 2: Redirect user to the OAuth URL
window.location.href = urlResponse.url;

// Step 3: Handle the callback (after user authorizes)
// The callback URL will include a 'code' parameter
const code = new URLSearchParams(window.location.search).get('code');

// Step 4: Exchange the code for a token
const tokenResponse = await domeApiClient.post('/content/notion/oauth', {
  code,
  redirectUri: 'https://dome.example.com/oauth/callback',
  userId: 'user-456'
});

if (tokenResponse.success) {
  console.log('OAuth configuration successful');
}
```

### Triggering a Manual Sync

```typescript
// Using the Dome API client
const response = await domeApiClient.post('/content/notion/workspace-123/sync');

if (response.success) {
  console.log(response.message);
}
```

### Retrieving Sync History

```typescript
// Using the Dome API client
const response = await domeApiClient.get('/content/notion/workspace-123/history', {
  params: { limit: 10 }
});

if (response.success) {
  console.log(`Found ${response.history.length} sync records`);
  
  // Display the most recent sync
  const latestSync = response.history[0];
  console.log(`Latest sync: ${latestSync.timestamp}`);
  console.log(`Status: ${latestSync.status}`);
  console.log(`Pages processed: ${latestSync.pagesProcessed}`);
}
```

## Deployment Considerations

### Environment Variables

The Notion ingestor requires the following environment variables:

- `NOTION_API_KEY`: API key for the Notion integration (for admin access)
- `NOTION_CLIENT_ID`: OAuth client ID from Notion developer portal
- `NOTION_CLIENT_SECRET`: OAuth client secret from Notion developer portal
- `NOTION_REDIRECT_URI`: OAuth redirect URI registered with Notion

### Rate Limiting

Notion's API has rate limits that should be considered:

- 3 requests per second per token
- 90 requests per minute per token
- 1000 requests per day per token (for free plans)

The implementation includes retry logic with exponential backoff to handle rate limiting gracefully.

### Security Considerations

1. **Token Storage**: OAuth tokens are sensitive and should be stored securely. The current implementation uses an in-memory store for development, but production deployments should use a secure KV store or other secure storage mechanism.

2. **User Authorization**: The system supports user-specific tokens, ensuring that users can only access workspaces they have authorized.

3. **Content Filtering**: The implementation includes filtering capabilities to prevent sensitive content from being ingested.

### Monitoring

The implementation includes comprehensive metrics and logging:

- Metrics for success/failure rates, latency, and content volume
- Structured logging for debugging and auditing
- Error tracking with context for troubleshooting

## Future Improvements

1. **Enhanced Content Filtering**
   - Support for custom ignore patterns
   - Content classification for sensitive information
   - User-configurable filtering rules

2. **Advanced Sync Options**
   - Selective sync for specific pages or databases
   - Differential sync to reduce bandwidth and processing
   - Real-time sync using Notion webhooks (when available)

3. **Content Transformation**
   - Improved rendering of complex Notion elements (tables, databases)
   - Support for embedded content and media
   - Preservation of rich formatting

4. **User Experience**
   - Workspace selection UI during OAuth flow
   - Sync status dashboard with real-time updates
   - Content preview before ingestion

5. **Performance Optimizations**
   - Parallel processing for large workspaces
   - Caching frequently accessed content
   - Optimized storage format for faster retrieval

6. **Integration Enhancements**
   - Support for Notion comments and discussions
   - Bi-directional sync capabilities
   - Integration with Notion's upcoming API features