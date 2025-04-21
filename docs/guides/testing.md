# Testing Guide

This guide outlines the testing approach, methodologies, and best practices for the Dome project. It provides comprehensive information on how to write, run, and maintain tests across the codebase.

## 1. Testing Philosophy

The Dome project follows a comprehensive testing approach that emphasizes:

- **Test-driven development (TDD)**: Write tests before implementing features when possible
- **Comprehensive coverage**: Aim for high test coverage across all services and packages
- **Realistic testing**: Test with realistic data and scenarios
- **Automated testing**: Integrate tests into the CI/CD pipeline
- **Maintainable tests**: Write clear, maintainable tests that serve as documentation

## 2. Testing Stack

The Dome project uses the following testing tools:

| Tool                                                  | Purpose                                      |
| ----------------------------------------------------- | -------------------------------------------- |
| [Vitest](https://vitest.dev/)                         | Test runner and framework                    |
| [Supertest](https://github.com/visionmedia/supertest) | HTTP assertions for API testing              |
| [MSW](https://mswjs.io/)                              | Mock Service Worker for API mocking          |
| [Miniflare](https://miniflare.dev/)                   | Local Cloudflare Workers runtime for testing |
| [Sinon](https://sinonjs.org/)                         | Spies, stubs, and mocks                      |
| [Chai](https://www.chaijs.com/)                       | Assertion library                            |

## 3. Test Types

### 3.1 Unit Tests

Unit tests focus on testing individual functions, classes, or components in isolation.

**Location**: `services/<service-name>/tests/unit/` or `packages/<package-name>/tests/unit/`

**Naming Convention**: `*.test.ts` or `*.spec.ts`

**Example**:

```typescript
// services/silo/tests/unit/utils/validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateContentType } from '../../../src/utils/validation';

describe('validateContentType', () => {
  it('should return true for valid content types', () => {
    expect(validateContentType('note')).toBe(true);
    expect(validateContentType('code')).toBe(true);
    expect(validateContentType('text/plain')).toBe(true);
  });

  it('should return false for invalid content types', () => {
    expect(validateContentType('invalid')).toBe(false);
    expect(validateContentType('')).toBe(false);
    expect(validateContentType(null as any)).toBe(false);
  });
});
```

### 3.2 Integration Tests

Integration tests focus on testing the interaction between multiple components or services.

**Location**: `services/<service-name>/tests/integration/`

**Naming Convention**: `*.test.ts` or `*.spec.ts`

**Example**:

```typescript
// services/silo/tests/integration/controllers/contentController.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { contentController } from '../../../src/controllers/contentController';
import { mockR2Bucket, mockD1Database } from '../../mocks/cloudflare';

describe('contentController', () => {
  beforeEach(() => {
    // Set up mocks
    mockR2Bucket.put.mockResolvedValue({});
    mockD1Database.prepare.mockReturnValue({
      bind: () => ({
        run: () => Promise.resolve({ success: true }),
      }),
    });
  });

  afterEach(() => {
    // Clean up mocks
    vi.resetAllMocks();
  });

  it('should store content and return an ID', async () => {
    const testData = {
      contentType: 'note',
      content: 'Test content',
      userId: 'user123',
    };

    const result = await contentController.simplePut(testData);

    expect(result).toHaveProperty('id');
    expect(mockR2Bucket.put).toHaveBeenCalledTimes(1);
    expect(mockD1Database.prepare).toHaveBeenCalledTimes(1);
  });
});
```

### 3.3 End-to-End Tests

End-to-end tests focus on testing the entire system from the user's perspective.

**Location**: `services/<service-name>/tests/e2e/`

**Naming Convention**: `*.test.ts` or `*.spec.ts`

**Example**:

```typescript
// services/dome-api/tests/e2e/api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestClient } from '@cloudflare/workers-test-client';
import { app } from '../../src/index';

describe('Dome API', () => {
  let client;

  beforeAll(async () => {
    // Create a test client
    client = createTestClient(app);
  });

  afterAll(async () => {
    // Clean up
    await client.close();
  });

  it('should return a 200 response for the health check endpoint', async () => {
    const response = await client.fetch('/health');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('status', 'ok');
  });

  it('should require authentication for protected endpoints', async () => {
    const response = await client.fetch('/api/notes');
    expect(response.status).toBe(401);
  });
});
```

### 3.4 Performance Tests

Performance tests focus on testing the performance characteristics of the system.

**Location**: `services/<service-name>/tests/performance/`

**Naming Convention**: `*.perf.ts`

**Example**:

```typescript
// services/constellation/tests/performance/embedding.perf.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { performance } from 'perf_hooks';
import { createEmbeddings } from '../../src/services/embedder';

describe('Embedding Performance', () => {
  it('should generate embeddings within acceptable time limits', async () => {
    const testData = Array(10).fill('This is a test document for embedding generation.');

    const start = performance.now();
    await createEmbeddings(testData);
    const end = performance.now();

    const duration = end - start;
    console.log(`Embedding generation took ${duration}ms for ${testData.length} documents`);

    // Expect embedding generation to take less than 2 seconds for 10 documents
    expect(duration).toBeLessThan(2000);
  });
});
```

## 4. Test Organization

### 4.1 Directory Structure

Tests are organized by service and package, with each having its own `tests` directory:

```
services/dome-api/
├── src/
└── tests/
    ├── unit/              # Unit tests
    │   ├── controllers/
    │   ├── services/
    │   └── utils/
    ├── integration/       # Integration tests
    │   ├── controllers/
    │   └── services/
    ├── e2e/               # End-to-end tests
    └── mocks/             # Mock implementations
```

### 4.2 Test Files

Test files should follow these naming conventions:

- Unit tests: `<file-being-tested>.test.ts`
- Integration tests: `<component-being-tested>.test.ts`
- End-to-end tests: `<feature-being-tested>.test.ts`
- Performance tests: `<component-being-tested>.perf.ts`

## 5. Writing Tests

### 5.1 Test Structure

Follow the Arrange-Act-Assert (AAA) pattern:

1. **Arrange**: Set up the test conditions
2. **Act**: Perform the action being tested
3. **Assert**: Verify the expected outcome

Example:

```typescript
it('should calculate the correct total', () => {
  // Arrange
  const items = [1, 2, 3, 4, 5];

  // Act
  const result = calculateTotal(items);

  // Assert
  expect(result).toBe(15);
});
```

### 5.2 Test Descriptions

Write clear, descriptive test titles:

- Describe what is being tested
- Describe the expected behavior
- Use the "it should" format

Example:

```typescript
describe('calculateTotal', () => {
  it('should return the sum of all items', () => {
    // Test implementation
  });

  it('should return 0 for an empty array', () => {
    // Test implementation
  });

  it('should throw an error for non-numeric items', () => {
    // Test implementation
  });
});
```

### 5.3 Mocking

Use mocks to isolate the code being tested:

```typescript
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { processData } from '../src/processData';
import { fetchData } from '../src/api';

// Mock the fetchData function
vi.mock('../src/api', () => ({
  fetchData: vi.fn(),
}));

describe('processData', () => {
  beforeEach(() => {
    // Set up the mock implementation
    (fetchData as any).mockResolvedValue({ data: [1, 2, 3] });
  });

  afterEach(() => {
    // Reset the mock
    vi.resetAllMocks();
  });

  it('should process data from the API', async () => {
    const result = await processData();

    expect(fetchData).toHaveBeenCalledTimes(1);
    expect(result).toEqual([2, 4, 6]);
  });
});
```

### 5.4 Testing Cloudflare Workers

Use Miniflare to test Cloudflare Workers:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMiniflareServer } from 'miniflare';
import { app } from '../src/index';

describe('Worker', () => {
  let server;

  beforeAll(async () => {
    server = await createMiniflareServer({
      modules: true,
      script: app,
      bindings: {
        // Mock bindings
        DB: createMockD1Database(),
        BUCKET: createMockR2Bucket(),
      },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('should handle requests', async () => {
    const response = await server.fetch('/api/endpoint');
    expect(response.status).toBe(200);
  });
});
```

### 5.5 Testing Asynchronous Code

Use `async/await` for testing asynchronous code:

```typescript
it('should fetch data asynchronously', async () => {
  const result = await fetchData();
  expect(result).toEqual({ data: 'value' });
});
```

### 5.6 Testing Error Handling

Test both success and error cases:

```typescript
describe('fetchData', () => {
  it('should return data on success', async () => {
    // Mock successful API call
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'value' }),
    });

    const result = await fetchData();
    expect(result).toEqual({ data: 'value' });
  });

  it('should throw an error on failure', async () => {
    // Mock failed API call
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(fetchData()).rejects.toThrow('API request failed: 404 Not Found');
  });
});
```

## 6. Running Tests

### 6.1 Running All Tests

To run all tests:

```bash
just test
```

### 6.2 Running Tests for a Specific Package

To run tests for a specific package:

```bash
just test-pkg <package-name>
```

For example, to run tests for the Silo service:

```bash
just test-pkg silo
```

### 6.3 Running a Specific Test File

To run a specific test file:

```bash
cd services/<service-name>
pnpm test path/to/test/file.test.ts
```

### 6.4 Running Tests with Coverage

To run tests with coverage:

```bash
just test-coverage
```

This will generate a coverage report in the `coverage` directory.

## 7. Test Coverage

### 7.1 Coverage Goals

The Dome project aims for the following coverage targets:

- **Unit tests**: 80% line coverage
- **Integration tests**: 70% line coverage
- **Overall coverage**: 75% line coverage

### 7.2 Checking Coverage

To check test coverage:

```bash
just test-coverage
```

This will generate a coverage report that you can view in your browser:

```bash
open coverage/index.html
```

### 7.3 Coverage Enforcement

The CI pipeline enforces minimum coverage thresholds. If coverage falls below the thresholds, the build will fail.

## 8. Testing in CI/CD

### 8.1 CI Pipeline

Tests are run as part of the CI pipeline on every pull request and push to the main branch.

The CI pipeline runs:

- Linting
- Type checking
- Unit tests
- Integration tests
- Coverage reporting

### 8.2 Test Results

Test results are reported in the CI pipeline and are available in the GitHub Actions interface.

Coverage reports are also generated and can be viewed as artifacts.

## 9. Testing Best Practices

### 9.1 General Best Practices

1. **Write tests first**: Follow test-driven development when possible
2. **Keep tests simple**: Each test should test one thing
3. **Use descriptive names**: Test names should describe what is being tested
4. **Avoid test interdependence**: Tests should not depend on each other
5. **Clean up after tests**: Reset state between tests
6. **Test edge cases**: Test boundary conditions and error cases
7. **Use realistic data**: Test with realistic data when possible
8. **Avoid testing implementation details**: Test behavior, not implementation

### 9.2 Cloudflare Workers Best Practices

1. **Mock Cloudflare bindings**: Use mock implementations of D1, R2, etc.
2. **Test with Miniflare**: Use Miniflare to test Workers in a realistic environment
3. **Test service bindings**: Mock service bindings to test inter-service communication
4. **Test queue consumers**: Test queue consumer logic with mock queues
5. **Test with realistic latency**: Simulate realistic network conditions

### 9.3 Performance Testing Best Practices

1. **Define clear performance goals**: Set specific performance targets
2. **Test with realistic load**: Test with realistic data volumes and request rates
3. **Measure key metrics**: Response time, throughput, resource usage
4. **Test in isolation**: Test performance of individual components
5. **Test end-to-end performance**: Test the entire system under load

## 10. Troubleshooting Common Test Issues

### 10.1 Tests Failing in CI but Passing Locally

Possible causes:

- **Environment differences**: Different Node.js versions, different OS
- **Timing issues**: Tests that depend on timing may be flaky
- **Resource limitations**: CI environment may have different resource limits

Solutions:

- Use the same Node.js version locally and in CI
- Avoid timing-dependent tests
- Mock external resources consistently

### 10.2 Slow Tests

Possible causes:

- **External dependencies**: Tests that call external services
- **Inefficient test setup**: Redundant setup for each test
- **Large test data**: Tests that use large datasets

Solutions:

- Mock external dependencies
- Use `beforeAll` for expensive setup
- Use smaller, focused test datasets

### 10.3 Flaky Tests

Possible causes:

- **Race conditions**: Tests that depend on specific execution order
- **Timing issues**: Tests that depend on specific timing
- **External dependencies**: Tests that depend on external services

Solutions:

- Avoid race conditions by using proper async/await
- Use explicit waits instead of timeouts
- Mock external dependencies

## 11. Conclusion

Testing is a critical part of the development process for the Dome project. By following the guidelines in this document, you can write effective, maintainable tests that help ensure the quality and reliability of the codebase.

Remember that tests serve multiple purposes:

- Verifying that code works as expected
- Preventing regressions
- Documenting code behavior
- Enabling confident refactoring

Invest time in writing good tests, and they will pay dividends throughout the life of the project.
