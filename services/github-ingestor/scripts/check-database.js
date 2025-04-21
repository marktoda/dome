#!/usr/bin/env node
/**
 * GitHub Ingestor Database Check Script
 *
 * This script helps diagnose issues with the D1 database used by the GitHub Ingestor service.
 * It uses wrangler to run D1 commands to check the database schema and data.
 *
 * Usage:
 *   node check-database.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Colors for output
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

/**
 * Run a wrangler D1 command and return the output
 */
function runD1Command(command) {
  try {
    console.log(`${BLUE}Running: wrangler d1 ${command}${RESET}`);
    const output = execSync(`wrangler d1 ${command}`, { encoding: 'utf8' });
    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}

/**
 * Get the database name from wrangler.toml
 */
function getDatabaseName() {
  try {
    const wranglerPath = path.join(process.cwd(), 'wrangler.toml');
    const wranglerContent = fs.readFileSync(wranglerPath, 'utf8');

    // Look for the database binding
    const dbMatch = wranglerContent.match(/\[\[d1_databases\]\]\s+binding\s*=\s*["'](\w+)["']/);
    if (dbMatch && dbMatch[1]) {
      return dbMatch[1];
    }

    // Look for the database name
    const nameMatch = wranglerContent.match(
      /\[\[d1_databases\]\]\s+database_name\s*=\s*["']([^"']+)["']/,
    );
    if (nameMatch && nameMatch[1]) {
      return nameMatch[1];
    }

    throw new Error('Could not find database name in wrangler.toml');
  } catch (error) {
    console.error(`${RED}Error getting database name: ${error.message}${RESET}`);
    return null;
  }
}

/**
 * Check the database schema
 */
async function checkSchema(dbName) {
  console.log(`\n${YELLOW}Checking database schema...${RESET}`);

  const result = runD1Command(
    `execute ${dbName} --command "SELECT name, sql FROM sqlite_master WHERE type='table'"`,
  );

  if (result.success) {
    console.log(`${GREEN}Schema retrieved successfully:${RESET}`);
    console.log(result.output);

    // Check for specific tables
    const tables = [
      'provider_repositories',
      'repository_sync_status',
      'content_blobs',
      'content_references',
    ];

    for (const table of tables) {
      if (result.output.includes(table)) {
        console.log(`${GREEN}✓ Table '${table}' exists${RESET}`);
      } else {
        console.log(`${RED}✗ Table '${table}' is missing${RESET}`);
      }
    }
  } else {
    console.error(`${RED}Failed to retrieve schema:${RESET}`);
    console.error(result.stderr || result.error);
  }
}

/**
 * Check table data
 */
async function checkTableData(dbName, table, limit = 5) {
  console.log(`\n${YELLOW}Checking data in '${table}' table...${RESET}`);

  const result = runD1Command(
    `execute ${dbName} --command "SELECT * FROM ${table} LIMIT ${limit}"`,
  );

  if (result.success) {
    if (result.output.includes('no rows returned')) {
      console.log(`${YELLOW}No data found in '${table}' table${RESET}`);
    } else {
      console.log(`${GREEN}Data retrieved successfully:${RESET}`);
      console.log(result.output);
    }
  } else {
    console.error(`${RED}Failed to retrieve data from '${table}':${RESET}`);
    console.error(result.stderr || result.error);
  }
}

/**
 * Run database diagnostics
 */
async function runDiagnostics() {
  console.log(`${BLUE}=== GitHub Ingestor Database Diagnostics ===${RESET}`);

  // Get the database name
  const dbName = getDatabaseName();
  if (!dbName) {
    console.error(`${RED}Could not determine database name. Exiting.${RESET}`);
    return;
  }

  console.log(`${BLUE}Using database: ${dbName}${RESET}`);

  // Check the database schema
  await checkSchema(dbName);

  // Check data in key tables
  await checkTableData(dbName, 'provider_repositories');
  await checkTableData(dbName, 'repository_sync_status');
  await checkTableData(dbName, 'content_blobs');
  await checkTableData(dbName, 'content_references');

  console.log(`\n${BLUE}=== Database Diagnostics Complete ===${RESET}`);
  console.log(`${YELLOW}If you see errors related to missing tables or schema issues:${RESET}`);
  console.log(`1. Check if the database migrations have been applied`);
  console.log(`2. Verify that the database ID in wrangler.toml is correct`);
  console.log(
    `3. Consider running migrations manually with 'wrangler d1 migrations apply ${dbName}'`,
  );
  console.log(`4. Check for any SQL syntax errors in the migrations`);
}

// Run the diagnostics
runDiagnostics().catch(error => {
  console.error(`${RED}Fatal error: ${error.message}${RESET}`);
  process.exit(1);
});
