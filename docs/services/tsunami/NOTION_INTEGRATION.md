# Notion Integration for Tsunami

## Overview

The Notion integration for Tsunami allows you to ingest content from Notion workspaces into your knowledge base. This integration supports both API key authentication and OAuth, enabling you to connect to Notion workspaces and automatically sync their content.

Key features:
- Connect to Notion workspaces using API keys or OAuth
- Automatically sync content on a configurable schedule
- Filter content based on customizable rules
- Track sync history and status
- Convert Notion-specific formatting to standard text

## Setup and Configuration

### Prerequisites

Before you can use the Notion integration, you need:

1. A Dome account with access to the Tsunami service
2. A Notion workspace you want to integrate
3. Either:
   - A Notion API key (for simple integration)
   - A Notion integration with OAuth capabilities (for multi-user integration)

### Option 1: Setting Up with a Notion API Key

#### 1. Create a Notion Integration

1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click "New integration"
3. Name your integration (e.g., "Dome Tsunami")
4. Select the workspace you want to connect
5. Set the capabilities required:
   - Read content
   - Read user information
   - Read comments
6. Click "Submit" to create the integration

#### 2. Get Your API Key

1. After creating the integration, you'll be taken to the integration details page
2. Copy the "Internal Integration Token" (this is your API key)

#### 3. Configure Tsunami

Set the following environment variable in your Tsunami service:

```
NOTION_API_KEY=your_api_key_here
```

### Option 2: Setting Up with OAuth

#### 1. Create a Notion OAuth Integration

1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click "New integration"
3. Name your integration (e.g., "Dome Tsunami")
4. Select the workspace you want to connect
5. Under "Authorization", select "Public integration"
6. Add a redirect URI (this should be your Tsunami service's OAuth callback URL)
   - Format: `https://your-domain.com/api/tsunami/notion/oauth/callback`
7. Set the capabilities required:
   - Read content
   - Read user information
   - Read comments
8. Click "Submit" to create the integration

#### 2. Get Your OAuth Credentials

1. After creating the integration, you'll be taken to the integration details page
2. Copy the "OAuth client ID" and "OAuth client secret"

#### 3. Configure Tsunami

Set the following environment variables in your Tsunami service:

```
NOTION_CLIENT_ID=your_client_id_here
NOTION_CLIENT_SECRET=your_client_secret_here
NOTION_REDIRECT_URI=https://your-domain.com/api/tsunami/notion/oauth/callback
```

### Granting Access to Your Notion Workspace

For both API key and OAuth integrations, you need to grant access to the specific pages or databases you want to sync:

1. Open your Notion workspace
2. Navigate to the page or database you want to share
3. Click "Share" in the top right corner
4. In the "Invite" field, select your integration
5. Click "Invite"

This grants your integration access to that page and all its subpages.

## Registering a Notion Workspace

Once you've set up the integration, you can register a Notion workspace for syncing:

### Using the API

```http
POST /api/tsunami/resource/notion
Content-Type: application/json

{
  "userId": "user123",
  "workspaceId": "your_workspace_id",
  "cadence": "PT1H"
}
```

The `cadence` parameter specifies how often to sync the workspace using ISO 8601 duration format:
- `PT1H`: Every hour
- `PT30M`: Every 30 minutes
- `P1D`: Every day

### Using the Client Library

```typescript
import { createTsunamiClient } from '@dome/tsunami/client';

const tsunami = createTsunamiClient(env.TSUNAMI);

// Register a Notion workspace
const result = await tsunami.registerNotionWorkspace(
  'your_workspace_id',
  'user123',
  3600 // Sync every hour (in seconds)
);

console.log(`Workspace registered with ID: ${result.id}`);
```

## Content Filtering

You can control which Notion content gets ingested using filtering rules.

### Default Filtering

By default, the Notion integration:
- Skips archived pages
- Processes all non-archived pages in the workspace

### Custom Filtering

To implement custom filtering, you can create a `.tsunamiignore` file in your project with specific rules for Notion content. This works similarly to the file filtering system described in [FILE_FILTERING.md](./FILE_FILTERING.md).

Example `.tsunamiignore` file with Notion-specific rules:

```
# Ignore specific Notion pages by ID
notion:page:a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6

# Ignore pages with specific titles (using regex)
notion:title:.*Draft.*
notion:title:.*Private.*

# Ignore specific databases
notion:database:a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

## Monitoring and Troubleshooting

### Viewing Sync History

You can view the sync history for a Notion workspace:

```typescript
// Get sync history for a Notion workspace
const history = await tsunami.getNotionWorkspaceHistory(
  'your_workspace_id',
  10 // Limit to 10 most recent entries
);

console.log(history);
```

### Common Issues and Solutions

#### Authentication Errors

**Issue**: "Failed to authenticate with Notion API"

**Solutions**:
- Verify your API key or OAuth credentials are correct
- Check that the environment variables are properly set
- Ensure your integration has the necessary capabilities enabled

#### Access Errors

**Issue**: "Access denied to Notion resource"

**Solutions**:
- Verify you've shared the page/database with your integration
- Check that your integration has the correct permissions
- For OAuth integrations, ensure the user has granted the necessary permissions

#### Rate Limiting

**Issue**: "Notion API rate limit exceeded"

**Solutions**:
- Reduce the sync frequency (increase the cadence value)
- Implement more specific filtering to reduce the number of API calls
- Contact Notion to request increased rate limits for your integration

#### Content Not Appearing

**Issue**: Content is not appearing in search results after syncing

**Solutions**:
- Check the sync history to ensure the sync completed successfully
- Verify the content isn't being filtered out by your filtering rules
- Ensure the content has been properly processed and indexed by the Silo service

## Advanced Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NOTION_API_KEY` | API key for direct integration | None |
| `NOTION_CLIENT_ID` | OAuth client ID | None |
| `NOTION_CLIENT_SECRET` | OAuth client secret | None |
| `NOTION_REDIRECT_URI` | OAuth redirect URI | None |
| `NOTION_VERSION` | Notion API version | `2022-06-28` |

### Customizing Content Processing

The Notion integration converts Notion blocks to text with appropriate formatting. The default conversion handles:

- Paragraphs
- Headings (levels 1-3)
- Lists (bulleted and numbered)
- To-do items
- Code blocks
- Quotes
- Callouts
- Tables
- Rich text formatting (bold, italic, strikethrough, code)
- Links

If you need to customize how Notion content is processed, you can extend the `extractTextFromBlock` and `extractRichText` functions in your own implementation.