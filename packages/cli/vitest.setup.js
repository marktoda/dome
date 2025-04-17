// This file is run before each test file
// It's a good place to set up global mocks or configuration
import { vi } from 'vitest';

// Mock the process.exit function to prevent tests from exiting
process.exit = vi.fn();

// Mock console.log to prevent cluttering test output
console.log = vi.fn();
console.error = vi.fn();