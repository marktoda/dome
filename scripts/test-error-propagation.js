#!/usr/bin/env node

/**
 * End-to-End test for error propagation across service boundaries
 *
 * This script tests how errors propagate between services, verifying:
 * 1. Request ID propagation across service boundaries
 * 2. Error context preservation and enrichment
 * 3. Consistent error formats in API responses
 *
 * Usage:
 *   node scripts/test-error-propagation.js
 */

const fetch = require('node-fetch');
const crypto = require('crypto');

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8787';
const SERVICES = ['dome-api', 'silo', 'constellation', 'ai-processor'];
const TEST_SCENARIOS = [
  { name: 'not_found', path: '/api/resource/nonexistent', expectedStatus: 404 },
  { name: 'validation_error', path: '/api/validate?invalid=true', expectedStatus: 400 },
  { name: 'service_unavailable', path: '/api/service/unavailable', expectedStatus: 503 },
  { name: 'timeout', path: '/api/timeout', expectedStatus: 504 },
  { name: 'internal_error', path: '/api/error', expectedStatus: 500 },
];

// Results storage
const results = {
  summary: {
    total: 0,
    passed: 0,
    failed: 0,
  },
  scenarios: [],
};

/**
 * Runs a single test scenario
 */
async function runTest(scenario) {
  const requestId = crypto.randomUUID();
  console.log(`\n[TEST] Running scenario: ${scenario.name} with request ID: ${requestId}`);

  const startTime = Date.now();
  const url = `${API_BASE_URL}${scenario.path}`;

  try {
    const response = await fetch(url, {
      headers: {
        'X-Request-ID': requestId,
      },
    });

    const duration = Date.now() - startTime;
    const responseData = await response.json();

    // Verify status code
    const statusMatch = response.status === scenario.expectedStatus;
    console.log(
      `Status Code: ${response.status} (expected: ${scenario.expectedStatus}) - ${
        statusMatch ? '✅' : '❌'
      }`,
    );

    // Verify request ID in response
    const responseRequestId = response.headers.get('x-request-id');
    const requestIdMatch = responseRequestId === requestId;
    console.log(`Request ID propagation: ${requestIdMatch ? '✅' : '❌'}`);

    // Verify error structure
    const hasErrorObject = responseData.error && typeof responseData.error === 'object';
    const hasErrorCode = hasErrorObject && typeof responseData.error.code === 'string';
    const hasErrorMessage = hasErrorObject && typeof responseData.error.message === 'string';

    console.log(
      `Error structure validation: ${
        hasErrorObject && hasErrorCode && hasErrorMessage ? '✅' : '❌'
      }`,
    );

    // Verify error details
    const hasRequestIdInDetails =
      hasErrorObject &&
      responseData.error.details &&
      responseData.error.details.requestId === requestId;

    console.log(`Request ID in error details: ${hasRequestIdInDetails ? '✅' : '❌'}`);

    // Check for service context enrichment
    const serviceContextEnriched =
      hasErrorObject && responseData.error.details && responseData.error.details.service;

    console.log(`Service context enrichment: ${serviceContextEnriched ? '✅' : '❌'}`);

    // Overall test result
    const passed =
      statusMatch &&
      requestIdMatch &&
      hasErrorObject &&
      hasErrorCode &&
      hasErrorMessage &&
      hasRequestIdInDetails;

    if (passed) {
      results.summary.passed++;
      console.log(`\nScenario ${scenario.name} PASSED ✅`);
    } else {
      results.summary.failed++;
      console.log(`\nScenario ${scenario.name} FAILED ❌`);
    }

    results.scenarios.push({
      name: scenario.name,
      url,
      requestId,
      duration,
      statusCode: response.status,
      expectedStatus: scenario.expectedStatus,
      passed,
      error: responseData.error || null,
      checks: {
        statusMatch,
        requestIdMatch,
        hasErrorObject,
        hasErrorCode,
        hasErrorMessage,
        hasRequestIdInDetails,
        serviceContextEnriched,
      },
    });
  } catch (error) {
    console.error(`Error running test "${scenario.name}":`, error);
    results.summary.failed++;

    results.scenarios.push({
      name: scenario.name,
      url,
      requestId,
      duration: Date.now() - startTime,
      error: error.message,
      passed: false,
    });
  }
}

/**
 * Checks service dependencies and status
 */
async function checkServices() {
  console.log('\n[SETUP] Checking service dependencies...');

  for (const service of SERVICES) {
    try {
      const response = await fetch(`${API_BASE_URL}/health/${service}`);
      const status = response.ok ? '✅' : '❌';
      console.log(`Service ${service}: ${status}`);

      if (!response.ok) {
        console.warn(`Warning: Service ${service} is not healthy, some tests may fail`);
      }
    } catch (error) {
      console.error(`Error checking service ${service}:`, error.message);
      console.warn(`Warning: Unable to verify service ${service}, some tests may fail`);
    }
  }
}

/**
 * Prints test results summary
 */
function printResults() {
  console.log('\n\n========== TEST RESULTS ==========');
  console.log(`Total Scenarios: ${results.summary.total}`);
  console.log(
    `Passed: ${results.summary.passed} (${Math.round(
      (results.summary.passed / results.summary.total) * 100,
    )}%)`,
  );
  console.log(
    `Failed: ${results.summary.failed} (${Math.round(
      (results.summary.failed / results.summary.total) * 100,
    )}%)`,
  );

  console.log('\nScenario Results:');
  results.scenarios.forEach(scenario => {
    console.log(`- ${scenario.name}: ${scenario.passed ? 'PASSED ✅' : 'FAILED ❌'}`);
  });

  console.log('\nRecommendations:');
  if (results.summary.failed > 0) {
    console.log('- Review service error handling implementations');
    console.log('- Check request ID propagation in service calls');
    console.log('- Verify error middleware configuration');
  } else {
    console.log('- All error propagation tests passed!');
    console.log('- Consider adding more edge case scenarios');
  }
}

/**
 * Main function
 */
async function main() {
  console.log('=== Error Propagation End-to-End Test ===');
  await checkServices();

  results.summary.total = TEST_SCENARIOS.length;

  for (const scenario of TEST_SCENARIOS) {
    await runTest(scenario);
  }

  printResults();

  // Exit with appropriate code
  process.exit(results.summary.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Unexpected error in test script:', error);
  process.exit(1);
});
