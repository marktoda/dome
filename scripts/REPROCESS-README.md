# Content Reprocessing Script

This script allows you to reprocess content items in the Dome platform by reading content IDs from a JSON file and calling the bulk reprocess endpoint in batches.

## Prerequisites

Before running the script, ensure you have the required dependency:

```bash
npm install node-fetch@2
```

Note: We're using node-fetch v2 as it supports CommonJS modules without additional configuration.

## Usage

```bash
node reprocess-content.js [--batch-size=50] [--file=scripts/contents.json] [--api-url=http://localhost:8787] [--token=your-auth-token]
```

### Parameters

- `--batch-size`: Number of content IDs to send in each API request (default: 50)
- `--file`: Path to the JSON file containing content IDs (default: scripts/contents.json)
- `--api-url`: URL of the Dome API (default: http://localhost:8787)
- `--token`: Authentication token to use for API requests (required for production environments)

### Example

```bash
node reprocess-content.js --file=./export-contents.json --api-url=https://api.dome.example.com --token=your-jwt-token --batch-size=100
```

## JSON File Format

The script supports several formats for the input JSON file:

1. The default format from `scripts/contents.json`:
```json
[
  {
    "results": [
      {
        "id": "01JSFZR292P3G7DYAX1DP396SS",
        "user_id": "00000-00000-00000-00000-00000",
        "category": "code",
        "mime_type": "text/plain",
        "size": 5881,
        "r2_key": "content/01JSFZR292P3G7DYAX1DP396SS",
        "sha256": null
      },
      // More items...
    ]
  }
]
```

2. An array of content objects with `id` property:
```json
[
  { "id": "content-id-1", "title": "Document 1" },
  { "id": "content-id-2", "title": "Document 2" }
]
```

3. An array of content IDs:
```json
["content-id-1", "content-id-2", "content-id-3"]
```

4. An object with an `items` property containing content objects:
```json
{
  "items": [
    { "id": "content-id-1", "title": "Document 1" },
    { "id": "content-id-2", "title": "Document 2" }
  ]
}
```

5. An object with a `contentIds` property containing an array of IDs:
```json
{
  "contentIds": ["content-id-1", "content-id-2", "content-id-3"]
}
```

6. An object with content IDs as keys:
```json
{
  "content-id-1": { "title": "Document 1" },
  "content-id-2": { "title": "Document 2" }
}
```

## Authentication

For production environments, you'll need to provide a valid JWT authentication token. Obtain this token by logging in through the dome-api authentication endpoints.
