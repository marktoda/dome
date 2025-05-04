# Notion API Documentation for Tsunami

This document details the API endpoints and methods available for interacting with the Notion integration in the Tsunami service.

## Overview

The Tsunami service provides both HTTP API endpoints (via the dome-api service) and a client library for programmatic access. The Notion integration allows you to register Notion workspaces for content syncing, manage authentication, and monitor sync status.

## Authentication

All API requests require authentication. The specific authentication method depends on how you're accessing the API:

- **HTTP API**: Requires a valid authentication token in the `Authorization` header
- **Client Library**: Uses Cloudflare Worker bindings for service-to-service communication

## API Endpoints

### Register a Notion Workspace

Registers a Notion workspace for syncing and creates a sync plan.

#### HTTP Request

```http
POST /api/tsunami/resource/notion
Content-Type: application/json
Authorization: Bearer <your_token>

{
  "userId": "user123",
  "workspaceId": "your_workspace_id",
  "cadence": "PT1H"
}
```

#### Request Parameters

| Parameter     | Type   | Required | Description                                                  |
| ------------- | ------ | -------- | ------------------------------------------------------------ |
| `userId`      | string | No       | User ID to associate with the sync plan                      |
| `workspaceId` | string | Yes      | Notion workspace ID to register                              |
| `cadence`     | string | No       | Sync frequency in ISO 8601 duration format (default: `PT1H`) |

#### Response

```json
{
  "success": true,
  "id": "01H1G2J3K4L5M6N7P8Q9R0S1T2",
  "resourceId": "your_workspace_id",
  "message": "Notion workspace registered for syncing"
}
```

or if the workspace is already registered:

```json
{
  "success": true,
  "id": "01H1G2J3K4L5M6N7P8Q9R0S1T2",
  "resourceId": "your_workspace_id",
  "message": "Notion workspace already registered, added user to existing sync plan"
}
```

#### Client Library Method

```typescript
async registerNotionWorkspace(
  workspaceId: string,
  userId?: string,
  cadenceSecs: number = 3600
): Promise<{ id: string; resourceId: string; wasInitialised: boolean }>
```

#### Example

```typescript
import { createTsunamiClient } from '@dome/tsunami/client';

const tsunami = createTsunamiClient(env.TSUNAMI);

const result = await tsunami.registerNotionWorkspace(
  'your_workspace_id',
  'user123',
  3600, // Sync every hour (in seconds)
);

console.log(`Workspace registered with ID: ${result.id}`);
console.log(`Was newly initialized: ${result.wasInitialised}`);
```

### Get Notion Workspace Sync History

Retrieves the sync history for a Notion workspace.

#### HTTP Request

```http
GET /api/tsunami/resource/notion/{workspaceId}/history?limit=10
Authorization: Bearer <your_token>
```

#### Request Parameters

| Parameter     | Type   | Required | Description                                               |
| ------------- | ------ | -------- | --------------------------------------------------------- |
| `workspaceId` | string | Yes      | Notion workspace ID                                       |
| `limit`       | number | No       | Maximum number of history records to return (default: 10) |

#### Response

```json
{
  "workspaceId": "your_workspace_id",
  "resourceId": "your_workspace_id",
  "history": [
    {
      "id": "hist_01H1G2J3K4L5M6N7P8Q9R0S1T2",
      "syncPlanId": "01H1G2J3K4L5M6N7P8Q9R0S1T2",
      "resourceId": "your_workspace_id",
      "timestamp": "2025-04-30T10:15:30.123Z",
      "status": "success",
      "itemsProcessed": 42,
      "itemsFiltered": 5,
      "durationMs": 1234,
      "error": null
    }
    // Additional history records...
  ]
}
```

#### Client Library Method

```typescript
async getNotionWorkspaceHistory(
  workspaceId: string,
  limit: number = 10
): Promise<{
  workspaceId: string;
  resourceId: string;
  history: unknown[];
}>
```

#### Example

```typescript
import { createTsunamiClient } from '@dome/tsunami/client';

const tsunami = createTsunamiClient(env.TSUNAMI);

const history = await tsunami.getNotionWorkspaceHistory(
  'your_workspace_id',
  10, // Limit to 10 most recent entries
);

console.log(history);
```

### Initiate OAuth Flow

Initiates the OAuth flow for connecting a Notion workspace.

#### HTTP Request

```http
GET /api/tsunami/notion/oauth/authorize?userId=user123&state=random_state_string
Authorization: Bearer <your_token>
```

#### Request Parameters

| Parameter | Type   | Required | Description                               |
| --------- | ------ | -------- | ----------------------------------------- |
| `userId`  | string | Yes      | User ID to associate with the OAuth token |
| `state`   | string | Yes      | Random string for CSRF protection         |

#### Response

Redirects to the Notion OAuth authorization page.

### OAuth Callback

Handles the callback from Notion after OAuth authorization.

#### HTTP Request

```http
GET /api/tsunami/notion/oauth/callback?code=authorization_code&state=random_state_string
```

#### Request Parameters

| Parameter | Type   | Required | Description                                     |
| --------- | ------ | -------- | ----------------------------------------------- |
| `code`    | string | Yes      | Authorization code from Notion                  |
| `state`   | string | Yes      | State parameter passed in the authorize request |

#### Response

Redirects to a success page or error page depending on the result.

## Error Handling

The API uses standard HTTP status codes to indicate the success or failure of requests:

- `200 OK`: The request was successful
- `400 Bad Request`: The request was invalid or missing required parameters
- `401 Unauthorized`: Authentication failed
- `403 Forbidden`: The authenticated user doesn't have permission to access the resource
- `404 Not Found`: The requested resource wasn't found
- `409 Conflict`: The request conflicts with the current state of the resource
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: An error occurred on the server

Error responses include a JSON body with details:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Notion workspace not found",
    "details": {
      "workspaceId": "your_workspace_id"
    }
  }
}
```

## Rate Limiting

The API is subject to rate limits both from the Tsunami service and from the Notion API. The Notion integration includes automatic retry logic for rate-limited requests, but clients should implement their own retry logic for HTTP API requests.

## Webhooks

The Tsunami service does not currently provide webhooks for Notion integration events. Sync status must be checked by polling the history endpoint.

## Client Library

The Tsunami client library provides a convenient way to interact with the Tsunami service programmatically. It handles authentication, serialization, and error handling.

### Installation

```bash
pnpm add @dome/tsunami
```

### Usage

```typescript
import { createTsunamiClient } from '@dome/tsunami/client';

// Create a client instance
const tsunami = createTsunamiClient(env.TSUNAMI);

// Register a Notion workspace
const result = await tsunami.registerNotionWorkspace(
  'your_workspace_id',
  'user123',
  3600, // Sync every hour (in seconds)
);

// Get sync history
const history = await tsunami.getNotionWorkspaceHistory(
  'your_workspace_id',
  10, // Limit to 10 most recent entries
);
```

## API Types

### TsunamiBinding Interface

```typescript
export interface TsunamiBinding {
  // Notion-specific methods
  registerNotionWorkspace(
    workspaceId: string,
    userId?: string,
    cadenceSecs?: number,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }>;

  // Generic methods used with Notion
  createSyncPlan(providerType: string, resourceId: string, userId?: string): Promise<string>;
  getSyncPlan(resourceId: string): Promise<any>;
  attachUser(syncPlanId: string, userId: string): Promise<void>;
  initializeResource(
    params: { resourceId: string; providerType: string; userId?: string },
    cadenceSecs: number,
  ): Promise<boolean>;
  getHistoryByResourceId(resourceId: string, limit: number): Promise<unknown[]>;
  getHistoryByUserId(userId: string, limit: number): Promise<unknown[]>;
  getHistoryBySyncPlanId(syncPlanId: string, limit: number): Promise<unknown[]>;
}
```

### TsunamiClient Class

The `TsunamiClient` class implements the `TsunamiBinding` interface and provides additional helper methods for working with Notion workspaces.

```typescript
export class TsunamiClient implements TsunamiService {
  // Constructor
  constructor(
    private readonly binding: TsunamiBinding,
    private readonly metricsPrefix: string = 'tsunami.client',
  ) {}

  // Notion-specific methods
  async registerNotionWorkspace(
    workspaceId: string,
    userId?: string,
    cadenceSecs: number = 3600,
  ): Promise<{ id: string; resourceId: string; wasInitialised: boolean }>;

  async getNotionWorkspaceHistory(
    workspaceId: string,
    limit: number = 10,
  ): Promise<{
    workspaceId: string;
    resourceId: string;
    history: unknown[];
  }>;

  // Generic methods used with Notion
  async createSyncPlan(providerType: string, resourceId: string, userId?: string): Promise<string>;
  async getSyncPlan(resourceId: string): Promise<any>;
  async attachUser(syncPlanId: string, userId: string): Promise<void>;
  async initializeResource(
    params: { resourceId: string; providerType: string; userId?: string },
    cadenceSecs: number,
  ): Promise<boolean>;
  async getHistoryByResourceId(resourceId: string, limit: number): Promise<unknown[]>;
  async getHistoryByUserId(userId: string, limit: number): Promise<unknown[]>;
  async getHistoryBySyncPlanId(syncPlanId: string, limit: number): Promise<unknown[]>;
}
```
