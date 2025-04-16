# Push Message Ingestor Tests

This directory contains tests for the push-message-ingestor service.

## Test Files

- `message.test.js` - Unit tests for message validation, service, and controller
- `setup.js` - Jest setup file to mock Cloudflare Worker environment
- `test-plan.md` - Comprehensive test plan for the service
- `test-report.md` - Test report documenting findings and recommendations
- `test-scripts.sh` - Shell scripts for testing the deployed service

## Running Tests

To run the unit tests:

```bash
# From the service directory
npm test

# Or with watch mode
npm run test:watch
```

## Testing Deployed Service

Once the service is deployed, you can use the test scripts to test it:

```bash
# Make the script executable
chmod +x tests/test-scripts.sh

# Run the tests against a deployed instance
./tests/test-scripts.sh https://your-deployed-service.workers.dev
```

## Test Plan

The `test-plan.md` file contains a comprehensive test plan for the service, including:

- Service overview
- Endpoints to test
- Test scenarios
- Expected responses
- Alternative testing approaches

## Test Report

The `test-report.md` file contains a test report documenting:

- Testing approach
- Code review findings
- Test results
- Recommendations
- Conclusion

## NixOS Limitations

Due to NixOS limitations with dynamically linked executables, running the service locally with Wrangler may not be possible. The tests in this directory provide alternative approaches to testing the service.
