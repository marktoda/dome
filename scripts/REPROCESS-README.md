# Content Reprocessing Script

This script allows you to reprocess content items in the Dome platform by reading content IDs from a JSON file and calling the bulk reprocess endpoint in batches.

## Prerequisites

Before running the script, ensure you have the required dependency:

```bash
npm install node-fetch@2
```

Note: We're using node-fetch v2 as it supports CommonJS modules without additional configuration.

## Authentication

**Important**: The API endpoint requires authentication. You must provide a valid authentication token when running the script:

```bash
node reprocess-content.js --token=your-jwt-token
```

The script will:
1. Check for the presence of a token (and fail with a clear error if none is provided)
2. Format the token correctly (adding 'Bearer ' prefix if needed)
3. Include the token in each API request

### Obtaining an Authentication Token

I've created a helper script to obtain an authentication token:

```bash
# Install required dependency if you haven't already
npm install node-fetch@2

# Run the authentication script
node scripts/get-auth-token.js --api-url=https://your-api-url --username=your-username --password=your-password
```

#### Secure Authentication Options

For better security, the script supports several authentication methods:

1. **Environment Variables**:
   ```bash
   export DOME_API_URL=https://your-api-url
   export DOME_USERNAME=your-username
   export DOME_PASSWORD=your-password
   node scripts/get-auth-token.js
   ```

2. **.env File**:
   Create a .env file in the root directory:
   ```
   DOME_API_URL=https://your-api-url
   DOME_USERNAME=your-username
   DOME_PASSWORD=your-password
   ```
   Then run:
   ```bash
   node scripts/get-auth-token.js
   ```

3. **Using the Generated Token File**:
   The script saves the token to a .token file in the scripts directory. You can use it directly:
   ```bash
   node scripts/reprocess-content.js --file=scripts/contents.json --token=$(cat scripts/.token)
   ```

The script will authenticate with the Dome API and print your JWT token, which you can use with the reprocess-content.js script. It will also show you the full command to run with the token included.

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
