# Manual Testing Steps for Public Vectors Implementation

This document outlines steps to manually test the public vectors implementation in the Constellation service.

## Prerequisites

- Access to a development environment with the Constellation service running
- Access to the Silo service for content storage
- Ability to create both user-specific and public content

## Test Scenarios

### 1. Creating Public Content

Test that content with `null` userId is correctly tagged as public content:

1. Create a new content item in Silo with `userId: null`

   ```bash
   # Example using curl or similar tool
   curl -X POST https://your-dev-silo-service.com/content \
     -H "Content-Type: application/json" \
     -d '{
       "id": "test-public-content",
       "userId": null,
       "body": "This is public content for testing",
       "category": "note",
       "mimeType": "text/markdown"
     }'
   ```

2. Verify in logs that the content is processed by the Constellation service

   ```bash
   # Check logs for the Constellation service
   wrangler tail constellation
   ```

3. Look for log entries showing the content being tagged with `PUBLIC_CONTENT_USER_ID`
   ```
   Converting message to embed job: userId=PUBLIC_CONTENT (was null)
   ```

### 2. Querying for Vectors

#### 2.1 User-Specific Query

Test that a user-specific query returns both the user's vectors and public vectors:

1. Create some user-specific content for "user1"

   ```bash
   curl -X POST https://your-dev-silo-service.com/content \
     -H "Content-Type: application/json" \
     -d '{
       "id": "user1-content",
       "userId": "user1",
       "body": "This is user1 specific content",
       "category": "note",
       "mimeType": "text/markdown"
     }'
   ```

2. Make a vector query for "user1"

   ```bash
   curl -X POST https://your-dev-constellation-service.com/query \
     -H "Content-Type: application/json" \
     -d '{
       "vector": [0.1, 0.2, 0.3, ...],
       "filter": {
         "userId": "user1"
       },
       "topK": 10
     }'
   ```

3. Verify in the response that both user1's content and public content are returned
   ```json
   {
     "results": [
       {
         "id": "user1-content",
         "score": 0.95,
         "metadata": {
           "userId": "user1",
           "contentId": "user1-content",
           "category": "note"
         }
       },
       {
         "id": "test-public-content",
         "score": 0.9,
         "metadata": {
           "userId": "PUBLIC_CONTENT",
           "contentId": "test-public-content",
           "category": "note"
         }
       }
     ]
   }
   ```

#### 2.2 Public-Only Query

Test querying for only public content:

1. Make a vector query with a filter that would only match public content

   ```bash
   curl -X POST https://your-dev-constellation-service.com/query \
     -H "Content-Type: application/json" \
     -d '{
       "vector": [0.1, 0.2, 0.3, ...],
       "filter": {
         "userId": "PUBLIC_CONTENT"
       },
       "topK": 10
     }'
   ```

2. Verify that only public content is returned
   ```json
   {
     "results": [
       {
         "id": "test-public-content",
         "score": 0.9,
         "metadata": {
           "userId": "PUBLIC_CONTENT",
           "contentId": "test-public-content",
           "category": "note"
         }
       }
     ]
   }
   ```

### 3. Testing with Multiple Users

Test that each user gets their own content plus public content, but not other users' content:

1. Create content for "user2"

   ```bash
   curl -X POST https://your-dev-silo-service.com/content \
     -H "Content-Type: application/json" \
     -d '{
       "id": "user2-content",
       "userId": "user2",
       "body": "This is user2 specific content",
       "category": "note",
       "mimeType": "text/markdown"
     }'
   ```

2. Query for "user1" and verify they get their content and public content, but not user2's content

   ```bash
   curl -X POST https://your-dev-constellation-service.com/query \
     -H "Content-Type: application/json" \
     -d '{
       "vector": [0.1, 0.2, 0.3, ...],
       "filter": {
         "userId": "user1"
       },
       "topK": 10
     }'
   ```

3. Query for "user2" and verify they get their content and public content, but not user1's content
   ```bash
   curl -X POST https://your-dev-constellation-service.com/query \
     -H "Content-Type: application/json" \
     -d '{
       "vector": [0.1, 0.2, 0.3, ...],
       "filter": {
         "userId": "user2"
       },
       "topK": 10
     }'
   ```

## Debugging Tips

1. Check the Cloudflare Workers logs for detailed information:

   ```bash
   wrangler tail constellation
   ```

2. Look for log entries related to filter modification:

   ```
   Using $in operator for userId filter: { userId: { $in: ['user1', 'PUBLIC_CONTENT'] } }
   ```

3. Verify the Vectorize index has the correct metadata index for userId:

   ```bash
   npx wrangler vectorize list-metadata-indexes <INDEX_NAME>
   ```

   If the userId metadata index is missing, create it:

   ```bash
   npx wrangler vectorize create-metadata-index <INDEX_NAME> --property-name=userId --type=string
   ```

4. Check the query results to ensure the correct vectors are being returned:
   ```
   Vectorize query results: { matches: [...] }
   ```

## Troubleshooting

If public vectors are not being returned in queries:

1. Verify that the content was properly tagged with `PUBLIC_CONTENT_USER_ID` during ingestion
2. Check that the userId metadata index exists in the Vectorize index
3. Ensure the query filter is being properly modified to include both the user's ID and `PUBLIC_CONTENT_USER_ID`
4. Verify that the Vectorize service supports the `$in` operator for filters
