# Push Message Ingestor Test Plan

This document outlines the comprehensive test plan for the Push Message Ingestor service, including test scenarios, execution instructions, and validation procedures.

## 1. Test Environment Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS version recommended)
- [pnpm](https://pnpm.io/) package manager
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) for Cloudflare Workers
- [curl](https://curl.se/) or [Postman](https://www.postman.com/) for API testing

### Local Test Environment

1. Clone the repository and navigate to the service directory:

```bash
# From the repository root
cd services/push-message-ingestor
```

2. Install dependencies:

```bash
pnpm install
```

3. Start the local development server:

```bash
wrangler dev
```

The service will be available at `http://localhost:8787` by default.

## 2. Test Categories

### 2.1 Unit Tests

Unit tests verify the functionality of individual components in isolation.

#### Running Unit Tests

```bash
# Run all unit tests
pnpm test

# Run tests in watch mode during development
pnpm test:watch

# Run tests with coverage report
pnpm test:coverage
```

#### Unit Test Scenarios

| Test Category | Test Cases |
|---------------|------------|
| **Message Validation** | - Valid message validation<br>- Invalid message validation<br>- Required field validation<br>- Field type validation |
| **Error Handling** | - AppError creation and handling<br>- ZodError handling<br>- Generic error handling |
| **Response Formatting** | - Success response formatting<br>- Error response formatting<br>- Correlation ID inclusion |
| **Pagination** | - Pagination options normalization<br>- Array pagination<br>- Batch processing |
| **Queue Integration** | - Message publishing<br>- Batch message publishing<br>- Error handling during publishing |

### 2.2 Integration Tests

Integration tests verify the interaction between components and external dependencies.

#### Running Integration Tests

```bash
# Option 1: Using the original test script
chmod +x tests/test-scripts.sh
./tests/test-scripts.sh http://localhost:8787

# Option 2: Using the fixed test script (recommended)
chmod +x tests/test-scripts-fixed.sh
./tests/test-scripts-fixed.sh http://localhost:8787

# Option 3: Using the test runner script (easiest)
chmod +x run-tests.sh
./run-tests.sh
```

#### Integration Test Scenarios

| Test Category | Test Cases |
|---------------|------------|
| **Base Endpoints** | - GET / (service info)<br>- GET /health (health check) |
| **Message Publishing** | - Valid single message<br>- Valid multiple messages<br>- Empty message array<br>- Invalid message format<br>- Missing required fields<br>- Invalid field types |
| **Error Responses** | - Validation error response format<br>- Server error response format<br>- Queue error response format |
| **Rate Limiting** | - Requests within rate limit<br>- Requests exceeding rate limit |
| **Correlation ID** | - Correlation ID in response headers<br>- Correlation ID in error responses |

### 2.3 End-to-End Tests

End-to-end tests verify the complete flow from API request to queue processing.

#### Running End-to-End Tests

```bash
# Start the service with queue binding
wrangler dev

# In a separate terminal, run the end-to-end test script
chmod +x tests/e2e-tests.sh
./tests/e2e-tests.sh http://localhost:8787
```

#### End-to-End Test Scenarios

| Test Category | Test Cases |
|---------------|------------|
| **Complete Flow** | - Message from API to queue<br>- Batch messages from API to queue |
| **Error Handling** | - Queue connection failure<br>- Queue publishing failure |
| **Performance** | - Large batch processing<br>- Concurrent requests |

## 3. Test Data

### 3.1 Valid Test Data

#### Single Valid Message

```json
{
  "messages": [
    {
      "id": "msg-123456",
      "timestamp": "2025-04-15T20:55:00.000Z",
      "platform": "telegram",
      "content": "Hello, world!",
      "metadata": {
        "chatId": "123456789",
        "messageId": "987654321",
        "fromUserId": "12345",
        "fromUsername": "user123"
      }
    }
  ]
}
```

#### Multiple Valid Messages

```json
{
  "messages": [
    {
      "id": "msg-123456",
      "timestamp": "2025-04-15T20:55:00.000Z",
      "platform": "telegram",
      "content": "Hello, world!",
      "metadata": {
        "chatId": "123456789",
        "messageId": "987654321"
      }
    },
    {
      "id": "msg-789012",
      "timestamp": "2025-04-15T20:56:00.000Z",
      "platform": "telegram",
      "content": "Second message",
      "metadata": {
        "chatId": "123456789",
        "messageId": "987654322"
      }
    }
  ]
}
```

### 3.2 Invalid Test Data

#### Missing Required Fields

```json
{
  "messages": [
    {
      "timestamp": "2025-04-15T20:55:00.000Z",
      "platform": "telegram",
      "content": "Hello, world!",
      "metadata": {
        "messageId": "987654321"
      }
    }
  ]
}
```

#### Invalid Field Types

```json
{
  "messages": [
    {
      "id": 12345,
      "timestamp": "invalid-date",
      "platform": "unknown",
      "content": 12345,
      "metadata": "not-an-object"
    }
  ]
}
```

#### Empty Message Array

```json
{
  "messages": []
}
```

#### Malformed JSON

```
{
  "messages": [
    {
      "id": "msg-123456",
      "timestamp": "2025-04-15T20:55:00.000Z",
      "platform": "telegram",
      "content": "Hello, world!",
      "metadata": {
        "chatId": "123456789",
        "messageId": "987654321"
      }
    }
  ]
```

## 4. Test Verification

### 4.1 Success Criteria

| Test Type | Success Criteria |
|-----------|------------------|
| **Unit Tests** | - All tests pass<br>- Code coverage > 80% |
| **Integration Tests** | - All endpoints return expected responses<br>- Error handling works as expected<br>- Rate limiting functions correctly |
| **End-to-End Tests** | - Messages are successfully published to the queue<br>- Error scenarios are handled gracefully |

### 4.2 Verification Methods

#### Response Status Codes

| Scenario | Expected Status Code |
|----------|---------------------|
| Successful request | 200 OK or 201 Created |
| Validation error | 400 Bad Request |
| Rate limit exceeded | 429 Too Many Requests |
| Server error | 500 Internal Server Error |

#### Response Format Verification

All responses should follow the standardized format:

```json
// Success response
{
  "success": true,
  "data": {
    // Response data
  }
}

// Error response
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error message",
    "correlationId": "unique-correlation-id",
    "details": {
      // Optional error details
    }
  }
}
```

#### Headers Verification

All responses should include:

- `Content-Type: application/json`
- `X-Correlation-ID: <unique-id>`

Rate-limited responses should include:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

## 5. Continuous Integration Testing

### GitHub Actions Workflow

The service is tested automatically on each pull request and push to the main branch using GitHub Actions:

```yaml
name: Push Message Ingestor Tests

on:
  push:
    branches: [ main ]
    paths:
      - 'services/push-message-ingestor/**'
  pull_request:
    branches: [ main ]
    paths:
      - 'services/push-message-ingestor/**'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - uses: pnpm/action-setup@v2
        with:
          version: 8
      - name: Install dependencies
        run: pnpm install
        working-directory: services/push-message-ingestor
      - name: Run tests
        run: pnpm test
        working-directory: services/push-message-ingestor
```

## 6. Regression Testing

Before each release, perform regression testing to ensure that existing functionality continues to work as expected:

1. Run all unit tests
2. Run all integration tests
3. Verify all endpoints manually using Postman or curl
4. Test with both valid and invalid data
5. Verify error handling and response formats
6. Check rate limiting functionality
7. Verify correlation ID propagation

## 7. Performance Testing

### 7.1 Load Testing

Test the service under expected load:

```bash
# Using k6 for load testing
k6 run tests/load-tests.js
```

### 7.2 Stress Testing

Test the service under extreme conditions:

```bash
# Using k6 for stress testing
k6 run tests/stress-tests.js
```

### 7.3 Performance Metrics

Monitor the following metrics during performance testing:

- Response time (average, p95, p99)
- Throughput (requests per second)
- Error rate
- CPU and memory usage
- Queue publishing latency

## 8. Security Testing

### 8.1 Input Validation Testing

Verify that all input validation works correctly:

- Test with malformed JSON
- Test with invalid field types
- Test with missing required fields
- Test with excessively large payloads
- Test with malicious input (SQL injection, XSS, etc.)

### 8.2 Rate Limiting Testing

Verify that rate limiting prevents abuse:

- Test with requests exceeding the rate limit
- Verify rate limit headers
- Test rate limit reset functionality

### 8.3 Error Handling Testing

Verify that errors are handled securely:

- Ensure stack traces are not exposed in production
- Verify that sensitive information is not leaked in error responses
- Test error logging to ensure sensitive data is properly sanitized

## 9. Test Automation

### 9.1 Automated Test Scripts

The following scripts automate testing:

- `run-tests.sh`: Runs all tests in sequence
- `test-scripts-fixed.sh`: Runs integration tests with improved JSON handling
- `e2e-tests.sh`: Runs end-to-end tests

### 9.2 Continuous Testing

Set up continuous testing during development:

```bash
# Run tests in watch mode
pnpm test:watch
```

## 10. Test Reporting

### 10.1 Test Coverage Report

Generate a test coverage report:

```bash
pnpm test:coverage
```

The report will be available in the `coverage` directory.

### 10.2 Test Results Report

After running tests, generate a summary report:

```bash
pnpm test:report
```

## 11. Troubleshooting

### Common Test Issues

| Issue | Solution |
|-------|----------|
| **Wrangler not found** | Install Wrangler globally: `npm install -g wrangler` |
| **Queue binding errors** | Ensure Wrangler is configured correctly with queue bindings |
| **Permission denied for test scripts** | Make scripts executable: `chmod +x tests/*.sh` |
| **JSON parsing errors** | Use the fixed test script: `./tests/test-scripts-fixed.sh` |
| **Rate limit errors during testing** | Increase the rate limit in development or add delays between requests |

## 12. Conclusion

This test plan provides a comprehensive approach to testing the Push Message Ingestor service. By following these procedures, we can ensure that the service functions correctly, handles errors gracefully, and meets performance and security requirements.

For any questions or issues with testing, please contact the development team.