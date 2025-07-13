#!/usr/bin/env node

/**
 * Run all context system tests
 */

console.log('🧪 Running Context System Test Suite\n');

const tests = [
  './context/schema.test.js',
  './context/parser.test.js',
  './context/manager.test.js',
  './context/integration.test.js'
];

let failed = false;

for (const test of tests) {
  console.log(`\n📋 Running ${test}\n`);
  
  try {
    await import(test);
  } catch (error) {
    console.error(`Failed to run ${test}:`, error);
    failed = true;
  }
}

if (failed) {
  console.log('\n❌ Some tests failed');
  process.exit(1);
} else {
  console.log('\n✅ All tests completed');
}