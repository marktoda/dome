# Testing the Push Message Ingestor Service

This document provides instructions for testing the push-message-ingestor service.

## Prerequisites

- Cloudflare Workers account
- Wrangler CLI installed
- curl and jq installed

## Running the Service Locally

To run the service locally:

```bash
cd services/push-message-ingestor
wrangler dev
```

This will start the service on http://localhost:8787 by default.

## Running the Tests

1. Make the test script executable:

```bash
chmod +x tests/test-scripts.sh
```

2. Run the tests against the local service:

```bash
./tests/test-scripts.sh http://localhost:8787
```

Or against a deployed service:

```bash
./tests/test-scripts.sh https://your-deployed-service.workers.dev
```

## Test Cases

The test script includes the following test cases:

1. Base endpoint (GET /)
2. Health check endpoint (GET /health)
3. Message publishing tests:
   - Valid message payload
   - Invalid message payload (missing required fields)
   - Empty message array
   - Multiple messages in a single request
   - Mixed valid and invalid messages

## Troubleshooting

If you encounter issues with the tests:

1. **"Message body cannot be undefined" error**:

   - This could indicate an issue with the JSON payload format
   - Check that the Content-Type header is set to application/json
   - Verify that the JSON payload is properly formatted

2. **"sendBatch() requires at least one message" error**:

   - This occurs when trying to send an empty array to the queue
   - The service has been updated to handle this case properly

3. **Permission denied when running the test script**:
   - Make sure the script is executable: `chmod +x tests/test-scripts.sh`

## Recent Fixes

The following issues have been fixed:

1. **JSON Parsing**: Enhanced error handling for JSON parsing in the controller
2. **Empty Arrays**: Added handling for empty message arrays in the service
3. **Test Scripts**: Improved the test scripts to use temporary files for JSON payloads

These fixes should resolve the issues encountered during testing.
