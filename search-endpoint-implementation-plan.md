# Search Endpoint Implementation Plan

## Problem Statement

The CLI is currently trying to access the `/notes/search` endpoint, but this is conflicting with the `/:id` route in the dome-api service. The `/:id` route is defined before the `/search` route, so when the CLI makes a request to `/notes/search`, it's being matched by the `/:id` route instead of the `/search` route.

## Solution: Create a Dedicated Top-Level Search Endpoint

We'll create a dedicated top-level search endpoint at `/search` instead of `/notes/search`, separating search functionality from the notes router.

## Implementation Steps

### 1. Update dome-api Service

#### 1.1. Modify `services/dome-api/src/index.ts`

```typescript
// After the existing routers but before mounting them

// Create a dedicated search router
const searchRouter = new Hono();

// Apply user ID middleware to all search routes
searchRouter.use('*', userIdMiddleware);

// Search endpoints
searchRouter.get('/', searchController.search.bind(searchController));
searchRouter.get('/stream', searchController.streamSearch.bind(searchController));

// Mount routers
app.route('/notes', notesRouter);
app.route('/search', searchRouter); // Mount the search router at /search
```

This creates a new router specifically for search functionality and mounts it at the `/search` path.

#### 1.2. Remove the search routes from the notes router

```typescript
// Remove these lines from the notes router section
// notesRouter.get('/search', searchController.search.bind(searchController));
// notesRouter.get('/search/stream', searchController.streamSearch.bind(searchController));
```

### 2. Update CLI Code

#### 2.1. Modify `packages/cli/src/utils/api.ts`

```typescript
export async function search(query: string, limit: number = 10): Promise<any> {
  const params = {
    q: query,
    limit,
  };

  // Use the new top-level search endpoint
  const response = await api.get('/search', { params });
  
  return {
    results: response.results || [],
    pagination: response.pagination || { total: 0, limit, offset: 0, hasMore: false },
    query,
  };
}
```

This updates the CLI to use the new `/search` endpoint instead of `/notes/search`.

### 3. Build and Deploy

#### 3.1. Build the CLI package

```bash
just build-pkg cli
```

#### 3.2. Build the dome-api service

```bash
just build-pkg dome-api
```

#### 3.3. Deploy the dome-api service

```bash
cd services/dome-api && wrangler deploy
```

## Benefits of This Approach

1. **Clean Separation of Concerns**: Search functionality is logically separated from note CRUD operations.
2. **Avoids Route Conflicts**: The dedicated endpoint avoids conflicts with wildcard routes.
3. **Scalability**: Makes it easier to add more search-related endpoints in the future.
4. **API Clarity**: Provides a clearer API structure for consumers.

## Testing

After implementation, test the search functionality using:

```bash
just cli search <query>
```

This should now correctly use the new `/search` endpoint and return search results without the 404 error.