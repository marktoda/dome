# GitHub Sync History Tracking

This document describes the sync history tracking system for the GitHub integration in the Tsunami service.

## Overview

The sync history tracking system records detailed information about each sync run, including:

- Timestamps (start and end times)
- Repository information
- User who triggered the sync
- Previous and new cursor values
- Number of files processed
- List of files that were updated
- Status of the sync (success or error)
- Error message (if applicable)

This information is stored in a `sync_history` table in the D1 database and can be queried through API endpoints.

## Database Schema

The sync history is stored in the `sync_history` table with the following schema:

| Column          | Type    | Description                                       |
| --------------- | ------- | ------------------------------------------------- |
| id              | TEXT    | Primary key (ULID)                                |
| sync_plan_id    | TEXT    | Reference to the sync plan                        |
| resource_id     | TEXT    | Resource identifier (e.g., owner/repo)            |
| provider        | TEXT    | Provider type (github, notion, etc.)              |
| user_id         | TEXT    | User who triggered the sync (if applicable)       |
| started_at      | INTEGER | Start timestamp (Unix timestamp)                  |
| completed_at    | INTEGER | End timestamp (Unix timestamp)                    |
| previous_cursor | TEXT    | Previous cursor value                             |
| new_cursor      | TEXT    | New cursor value after sync                       |
| files_processed | INTEGER | Number of files processed                         |
| updated_files   | TEXT    | List of file paths that were updated (JSON array) |
| status          | TEXT    | Status of the sync (success, error)               |
| error_message   | TEXT    | Error message if the sync failed                  |

## API Endpoints

The following API endpoints are available to query the sync history:

### Get Sync History for a GitHub Repository

```
GET /resource/github/:owner/:repo/history
```

**Parameters:**

- `owner` (path): Repository owner
- `repo` (path): Repository name
- `limit` (query, optional): Maximum number of history entries to return (default: 10, max: 100)

**Response:**

```json
{
  "success": true,
  "resourceId": "owner/repo",
  "history": [
    {
      "id": "01HXYZ...",
      "syncPlanId": "01HABC...",
      "resourceId": "owner/repo",
      "provider": "github",
      "userId": "user123",
      "startedAt": 1682123456,
      "completedAt": 1682123458,
      "previousCursor": "abc123",
      "newCursor": "def456",
      "filesProcessed": 5,
      "updatedFiles": ["src/index.ts", "src/components/Button.tsx", "README.md"],
      "status": "success"
    }
  ]
}
```

### Get Sync History for a User

```
GET /user/:userId/history
```

**Parameters:**

- `userId` (path): User ID
- `limit` (query, optional): Maximum number of history entries to return (default: 10, max: 100)

**Response:**

```json
{
  "success": true,
  "userId": "user123",
  "history": [
    {
      "id": "01HXYZ...",
      "syncPlanId": "01HABC...",
      "resourceId": "owner/repo",
      "provider": "github",
      "userId": "user123",
      "startedAt": 1682123456,
      "completedAt": 1682123458,
      "previousCursor": "abc123",
      "newCursor": "def456",
      "filesProcessed": 5,
      "updatedFiles": ["src/index.ts", "src/components/Button.tsx", "README.md"],
      "status": "success"
    }
  ]
}
```

### Get Sync History for a Sync Plan

```
GET /sync-plan/:syncPlanId/history
```

**Parameters:**

- `syncPlanId` (path): Sync plan ID
- `limit` (query, optional): Maximum number of history entries to return (default: 10, max: 100)

**Response:**

```json
{
  "success": true,
  "syncPlanId": "01HABC...",
  "history": [
    {
      "id": "01HXYZ...",
      "syncPlanId": "01HABC...",
      "resourceId": "owner/repo",
      "provider": "github",
      "userId": "user123",
      "startedAt": 1682123456,
      "completedAt": 1682123458,
      "previousCursor": "abc123",
      "newCursor": "def456",
      "filesProcessed": 5,
      "updatedFiles": ["src/index.ts", "src/components/Button.tsx", "README.md"],
      "status": "success"
    }
  ]
}
```

## Implementation Details

The sync history tracking system is implemented in the following components:

1. **Database Schema**: The `sync_history` table is defined in `services/tsunami/src/db/schema.ts`.

2. **Database Operations**: The `syncHistoryOperations` object in `services/tsunami/src/db/client.ts` provides methods to create and query sync history entries.

3. **ResourceObject**: The `sync` method in `services/tsunami/src/resourceObject.ts` records sync history during the sync process.

4. **API Endpoints**: The endpoints in `services/tsunami/src/index.ts` provide access to the sync history data.

5. **Migration Script**: The `services/tsunami/migrations/0002_add_sync_history_table.sql` script creates the `sync_history` table in the D1 database.

## Usage Examples

### Tracking Sync Progress

You can use the sync history to track the progress of syncs over time. For example, you can see how many files are processed in each sync run and which files are updated.

### Troubleshooting Sync Issues

If a sync fails, you can check the sync history to see the error message and which files were being processed when the error occurred.

### Auditing Repository Changes

You can use the sync history to audit changes to a repository over time. For example, you can see which files were updated in each sync run and when those updates occurred.
