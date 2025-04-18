#!/usr/bin/env node

/**
 * Dome Platform Logging Verification Script
 *
 * This script makes requests to a test endpoint to generate logs
 * that can be verified in Cloudflare Logs Engine.
 *
 * Usage:
 *   node scripts/verify-logging.js [options]
 *
 * Options:
 *   --endpoint <url>    Test endpoint URL (default: http://localhost:8787)
 *   --requests <num>    Number of requests to make (default: 10)
 *   --interval <ms>     Interval between requests in ms (default: 500)
 *   --error             Include error requests
 *   --help              Show this help message
 */

const http = require('http');
const https = require('https');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  endpoint: 'http://localhost:8787',
  requests: 10,
  interval: 500,
  includeErrors: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--endpoint' && i + 1 < args.length) {
    options.endpoint = args[++i];
  } else if (arg === '--requests' && i + 1 < args.length) {
    options.requests = parseInt(args[++i], 10);
  } else if (arg === '--interval' && i + 1 < args.length) {
    options.interval = parseInt(args[++i], 10);
  } else if (arg === '--error') {
    options.includeErrors = true;
  } else if (arg === '--help') {
    console.log(`
Dome Platform Logging Verification Script

This script makes requests to a test endpoint to generate logs
that can be verified in Cloudflare Logs Engine.

Usage:
  node scripts/verify-logging.js [options]

Options:
  --endpoint <url>    Test endpoint URL (default: http://localhost:8787)
  --requests <num>    Number of requests to make (default: 10)
  --interval <ms>     Interval between requests in ms (default: 500)
  --error             Include error requests
  --help              Show this help message
    `);
    process.exit(0);
  }
}

// Generate a random request ID
function generateRequestId() {
  return 'test-' + Math.random().toString(36).substring(2, 15);
}

// Make an HTTP request to the endpoint
function makeRequest(path = '/', requestId = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, options.endpoint);
    const client = url.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent': 'Dome-Logging-Verification-Script/1.0',
    };

    if (requestId) {
      headers['X-Request-ID'] = requestId;
    }

    const req = client.get(url.toString(), { headers }, res => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          requestId: res.headers['x-request-id'] || requestId,
        });
      });
    });

    req.on('error', error => {
      reject(error);
    });
  });
}

// Run the verification
async function runVerification() {
  console.log(`
🔍 Dome Platform Logging Verification
====================================
Endpoint: ${options.endpoint}
Requests: ${options.requests}
Interval: ${options.interval}ms
Include Errors: ${options.includeErrors ? 'Yes' : 'No'}
====================================
  `);

  const requestIds = [];

  for (let i = 0; i < options.requests; i++) {
    const requestId = generateRequestId();
    requestIds.push(requestId);

    try {
      // Determine path based on request number
      let path = '/';

      // Every third request goes to a different path
      if (i % 3 === 1) {
        path = '/api/test';
      } else if (i % 3 === 2) {
        path = '/api/users';
      }

      // Every fourth request should trigger an error if enabled
      if (options.includeErrors && i % 4 === 3) {
        path = '/error';
      }

      console.log(`Request ${i + 1}/${options.requests}: ${path} (ID: ${requestId})`);
      const response = await makeRequest(path, requestId);

      console.log(`  Status: ${response.statusCode}`);
      console.log(`  Request ID: ${response.requestId}`);

      // Wait before next request
      if (i < options.requests - 1) {
        await new Promise(resolve => setTimeout(resolve, options.interval));
      }
    } catch (error) {
      console.error(`  Error: ${error.message}`);
    }
  }

  console.log(`
✅ Verification Complete
====================================
  `);

  console.log(`
📋 How to Check Logs in Cloudflare Logs Engine
====================================

1. Log in to the Cloudflare Dashboard (https://dash.cloudflare.com)
2. Navigate to Workers & Pages → Logs
3. Select the "dome_logs" dataset
4. Run one of these queries to view the logs:

SQL Query for all logs from this verification:
------------------------------------
SELECT
  ts,
  lvl,
  service,
  msg,
  requestId,
  data
FROM dome_logs
WHERE requestId IN ('${requestIds.join("','")}')
ORDER BY ts ASC

SQL Query for error logs:
------------------------------------
SELECT
  ts,
  service,
  msg,
  err.name,
  err.msg,
  requestId
FROM dome_logs
WHERE lvl = 'error'
  AND ts > now() - INTERVAL 1 HOUR
ORDER BY ts DESC
LIMIT 100

SQL Query for request durations:
------------------------------------
SELECT
  requestId,
  service,
  durMs,
  data.path as path
FROM dome_logs
WHERE msg = 'request:end'
  AND ts > now() - INTERVAL 1 HOUR
ORDER BY durMs DESC
LIMIT 20
  `);
}

// Run the verification
runVerification().catch(error => {
  console.error('Verification failed:', error);
  process.exit(1);
});
