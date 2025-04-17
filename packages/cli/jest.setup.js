// This file is run before each test file
// It's a good place to set up global mocks or configuration

// Mock the process.exit function to prevent tests from exiting
process.exit = jest.fn();

// Mock console.log to prevent cluttering test output
console.log = jest.fn();
console.error = jest.fn();