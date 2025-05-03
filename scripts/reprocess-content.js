#!/usr/bin/env node

/**
 * Reprocess Content Script
 * 
 * This script reads content IDs from a JSON file and calls the bulk-reprocess endpoint
 * to reprocess them in batches.
 * 
 * Usage:
 *   node reprocess-content.js [--batch-size=50] [--file=scripts/contents.json] [--api-url=http://localhost:8787] [--token=your-auth-token]
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// Default configuration
const DEFAULT_CONFIG = {
  batchSize: 50,
  filePath: path.join(__dirname, 'contents.json'),
  apiUrl: 'https://dome-api.chatter-9999.workers.dev',
  endpoint: '/ai/bulk-reprocess',
  token: null,
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };

  for (const arg of args) {
    if (arg.startsWith('--batch-size=')) {
      config.batchSize = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--file=')) {
      config.filePath = arg.split('=')[1];
    } else if (arg.startsWith('--api-url=')) {
      config.apiUrl = arg.split('=')[1];
    } else if (arg.startsWith('--token=')) {
      config.token = arg.split('=')[1];
    }
  }

  return config;
}

// Check if file exists
function checkFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }
}

// Read JSON file
function readJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error reading or parsing JSON file: ${error.message}`);
    process.exit(1);
  }
}

// Extract content IDs from the JSON file
function extractContentIds(jsonData) {
  // Handle the specific format from the provided contents.json:
  // Array with items containing 'results' array of content objects
  if (Array.isArray(jsonData) && jsonData.length > 0 && jsonData[0].results && Array.isArray(jsonData[0].results)) {
    // Flatten the results arrays and extract IDs
    return jsonData.flatMap(item => item.results.map(result => result.id));
  }
  
  // If it's an array of content objects with id property
  if (Array.isArray(jsonData)) {
    if (jsonData.length > 0 && jsonData[0].id) {
      return jsonData.map(item => item.id);
    }
    // If it's an array of IDs
    if (jsonData.length > 0 && typeof jsonData[0] === 'string') {
      return jsonData;
    }
  }
  
  // If it's an object with an 'items' property containing content objects
  if (jsonData.items && Array.isArray(jsonData.items)) {
    return jsonData.items.map(item => item.id);
  }
  
  // If it's an object with a 'contentIds' property containing an array of IDs
  if (jsonData.contentIds && Array.isArray(jsonData.contentIds)) {
    return jsonData.contentIds;
  }

  // If it's an object with content IDs as keys
  if (typeof jsonData === 'object' && !Array.isArray(jsonData)) {
    return Object.keys(jsonData);
  }

  console.error('Error: Could not extract content IDs from the JSON file. Unsupported format.');
  process.exit(1);
}

// Split array into batches
function createBatches(items, batchSize) {
  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

// Validate and format the authentication token
function prepareAuthToken(token) {
  if (!token) {
    console.error('ERROR: No authentication token provided. API calls will fail.');
    console.error('Please provide a token with --token=your-auth-token');
    process.exit(1);
  }
  
  // Format token correctly (add Bearer prefix if it's not already there)
  if (!token.startsWith('Bearer ')) {
    return `Bearer ${token}`;
  }
  
  return token;
}

// Call the API endpoint with a batch of content IDs
async function callBulkReprocessEndpoint(apiUrl, endpoint, batch, token) {
  try {
    const url = `${apiUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': prepareAuthToken(token)
    };
    
    console.log(`Calling ${url} with ${batch.length} content IDs...`);
    console.log(`Using authentication token: ${headers.Authorization.substring(0, 15)}...`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contentIds: batch }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed with status ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error(`Error calling API: ${error.message}`);
    return null;
  }
}

// Main function
async function main() {
  const config = parseArgs();
  console.log('Configuration:', config);

  // Validate authentication token
  if (!config.token) {
    console.error('ERROR: No authentication token provided.');
    console.error('Please provide a token with --token=your-auth-token');
    process.exit(1);
  }

  // Check if file exists
  checkFile(config.filePath);

  // Read and parse JSON file
  const jsonData = readJsonFile(config.filePath);
  
  // Extract content IDs
  const contentIds = extractContentIds(jsonData);
  console.log(`Found ${contentIds.length} content IDs in the file.`);

  // Create batches
  const batches = createBatches(contentIds, config.batchSize);
  console.log(`Created ${batches.length} batches of max size ${config.batchSize}.`);

  // Process batches
  let successCount = 0;
  let failureCount = 0;
  let totalReprocessed = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Processing batch ${i + 1}/${batches.length} (${batch.length} items)...`);

    const result = await callBulkReprocessEndpoint(
      config.apiUrl,
      config.endpoint,
      batch,
      config.token
    );

    if (result && result.success) {
      successCount++;
      totalReprocessed += result.result.reprocessed;
      console.log(`Batch ${i + 1} succeeded. Reprocessed ${result.result.reprocessed} items.`);
    } else {
      failureCount++;
      console.error(`Batch ${i + 1} failed.`);
    }

    // Add a small delay between batches to avoid overwhelming the server
    if (i < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Print summary
  console.log('\nSummary:');
  console.log(`Total content IDs: ${contentIds.length}`);
  console.log(`Batches succeeded: ${successCount}/${batches.length}`);
  console.log(`Batches failed: ${failureCount}/${batches.length}`);
  console.log(`Total items reprocessed: ${totalReprocessed}`);
}

// Run the script
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
