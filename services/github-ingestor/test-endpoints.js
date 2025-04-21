/**
 * Simple test script to verify GitHub Ingestor endpoints
 *
 * This script tests the following endpoints:
 * - Root endpoint (/)
 * - Health endpoint (/health)
 * - Status endpoint (/status)
 *
 * Usage:
 * 1. Deploy the GitHub Ingestor service
 * 2. Run this script with the service URL:
 *    node test-endpoints.js https://github-ingestor.your-worker.workers.dev
 */

const baseUrl = process.argv[2] || 'http://localhost:8787';

async function testEndpoints() {
  console.log(`Testing GitHub Ingestor endpoints at ${baseUrl}`);
  console.log('---------------------------------------------------');

  // Test root endpoint
  try {
    console.log('Testing root endpoint (/)...');
    const rootResponse = await fetch(`${baseUrl}/`);
    const rootData = await rootResponse.json();

    console.log(`Status: ${rootResponse.status}`);
    console.log('Response:');
    console.log(JSON.stringify(rootData, null, 2));
    console.log('Root endpoint test: SUCCESS');
  } catch (error) {
    console.error('Root endpoint test: FAILED');
    console.error(error);
  }

  console.log('---------------------------------------------------');

  // Test health endpoint
  try {
    console.log('Testing health endpoint (/health)...');
    const healthResponse = await fetch(`${baseUrl}/health`);
    const healthData = await healthResponse.json();

    console.log(`Status: ${healthResponse.status}`);
    console.log('Response:');
    console.log(JSON.stringify(healthData, null, 2));

    if (healthData.status === 'ok') {
      console.log('Health endpoint test: SUCCESS');
    } else {
      console.log('Health endpoint test: WARNING - Service not healthy');
      console.log('Check the following components:');

      if (healthData.components) {
        Object.entries(healthData.components).forEach(([name, info]) => {
          console.log(`- ${name}: ${info.status} ${info.error ? `(${info.error})` : ''}`);
        });
      }
    }
  } catch (error) {
    console.error('Health endpoint test: FAILED');
    console.error(error);
  }

  console.log('---------------------------------------------------');

  // Test status endpoint
  try {
    console.log('Testing status endpoint (/status)...');
    const statusResponse = await fetch(`${baseUrl}/status`);
    const statusData = await statusResponse.json();

    console.log(`Status: ${statusResponse.status}`);
    console.log('Response:');
    console.log(JSON.stringify(statusData, null, 2));
    console.log('Status endpoint test: SUCCESS');
  } catch (error) {
    console.error('Status endpoint test: FAILED');
    console.error(error);
  }

  console.log('---------------------------------------------------');
  console.log('Testing complete!');
}

testEndpoints().catch(error => {
  console.error('Test script failed:');
  console.error(error);
  process.exit(1);
});
