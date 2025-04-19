# Dome API Test Plan

This document outlines the testing strategy and approach for the dome-api service, including unit tests, integration tests, and test coverage goals.

## Testing Approach

The dome-api service follows a comprehensive testing approach that includes:

1. **Unit Tests**: Testing individual components (controllers, services, repositories) in isolation
2. **Integration Tests**: Testing the complete flow from API endpoints through controllers to services and repositories
3. **Mocking**: Using mocks and stubs to isolate components and simulate external dependencies

## Test Structure

The test files are organized in a structure that mirrors the source code:

```
services/dome-api/tests/
├── controllers/           # Unit tests for controllers
├── services/              # Unit tests for services
├── repositories/          # Unit tests for repositories
├── integration/           # Integration tests for API endpoints
└── setup.js               # Test setup and configuration
```

## Unit Tests

### Controllers

Controller tests focus on verifying that:
- Controllers properly handle HTTP requests and responses
- Input validation works correctly
- Controllers delegate to the appropriate services
- Error handling is implemented correctly

Key controller tests:
- `noteController.test.ts`: Tests for note creation, retrieval, updating, and deletion
- `searchController.test.ts`: Tests for search functionality and streaming responses

### Services

Service tests focus on verifying that:
- Business logic is implemented correctly
- Services interact properly with repositories
- Error handling is implemented correctly
- Edge cases are handled appropriately

Key service tests:
- `noteService.test.ts`: Tests for note operations including embedding processing
- `searchService.test.ts`: Tests for search functionality, caching, and pagination

### Repositories

Repository tests focus on verifying that:
- Data access operations work correctly
- Database queries are constructed properly
- Error handling is implemented correctly

Key repository tests:
- `noteRepository.test.ts`: Tests for note CRUD operations
- `reminderRepository.test.ts`: Tests for reminder operations
- `taskRepository.test.ts`: Tests for task operations

## Integration Tests

Integration tests verify the complete flow from API endpoints through controllers to services and repositories. These tests use a Hono app instance to simulate HTTP requests and verify responses.

Key integration tests:
- `notes.test.ts`: Tests for note API endpoints
- `search.test.ts`: Tests for search API endpoints
- `chatStreaming.test.ts`: Tests for chat streaming functionality

## Test Scenarios

### Note Controller and Service

1. **Note Creation**
   - Create a note with valid data
   - Create a note with a provided title
   - Create a note with generated title
   - Handle validation errors during creation
   - Handle service errors during creation

2. **Note Retrieval**
   - Get a note by ID
   - Handle not found errors
   - Handle unauthorized access

3. **Note Listing**
   - List notes for a user
   - Apply content type filtering
   - Apply pagination
   - Handle service errors

4. **Note Updates**
   - Update a note with valid data
   - Handle validation errors during update
   - Handle not found errors
   - Handle unauthorized access
   - Verify embedding regeneration when content changes

5. **Note Deletion**
   - Delete a note
   - Handle not found errors
   - Handle unauthorized access

### Search Controller and Service

1. **Basic Search**
   - Search with valid query
   - Handle short queries (less than 3 characters)
   - Apply content type filtering
   - Apply date range filtering
   - Apply pagination

2. **Search Caching**
   - Use cached results when available
   - Regenerate cache when expired
   - Clear cache

3. **Streaming Search**
   - Stream search results
   - Handle errors during streaming
   - Verify proper NDJSON format

4. **Error Handling**
   - Handle validation errors
   - Handle service errors
   - Handle unexpected errors

## Mocking Strategy

The tests use the following mocking strategy:

1. **Service Mocks**: In controller tests, services are mocked to isolate controller logic
2. **Repository Mocks**: In service tests, repositories are mocked to isolate service logic
3. **External Service Mocks**: Services like embeddingService and vectorizeService are mocked
4. **Environment Mocks**: Cloudflare Workers environment bindings are mocked

## Test Coverage Goals

The test coverage goals for the dome-api service are:

- **Line Coverage**: 80% or higher
- **Branch Coverage**: 70% or higher
- **Function Coverage**: 90% or higher

Priority areas for coverage:
1. Core business logic in services
2. Error handling paths
3. Edge cases and validation

## Running Tests

To run the tests:

```bash
# Run all tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Run specific test file
pnpm test -- services/dome-api/tests/services/noteService.test.ts

# Run tests in watch mode
pnpm test:watch
```

## Continuous Integration

Tests are automatically run as part of the CI/CD pipeline. The pipeline:
1. Installs dependencies
2. Runs linting
3. Runs tests
4. Generates coverage reports
5. Fails the build if coverage thresholds are not met

## Future Improvements

1. Add more integration tests for edge cases
2. Implement end-to-end tests with a real database
3. Add performance tests for critical paths
4. Implement contract tests for API endpoints
5. Add snapshot tests for complex response structures
