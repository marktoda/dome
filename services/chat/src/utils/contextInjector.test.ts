import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { injectSituationalContext, UserContextData } from './contextInjector';

describe('contextInjector', () => {
  // Mock the Date object to have consistent test results
  const mockDate = new Date('2025-05-02T12:30:00Z');
  const originalDate = global.Date;

  beforeEach(() => {
    // @ts-ignore - Override constructor
    global.Date = class extends Date {
      constructor() {
        super();
        return mockDate;
      }
      // Ensure static methods work
      static now() {
        return mockDate.getTime();
      }
    };
  });

  afterEach(() => {
    // Restore original Date
    global.Date = originalDate;
  });

  test('should inject date and time context', () => {
    const prompt = 'This is a test prompt';
    const result = injectSituationalContext(prompt);

    // Date format will depend on the locale, so we check for presence rather than exact format
    expect(result).toContain('Current Date:');
    expect(result).toContain('Current Time:');
    expect(result).toContain('--- Original Prompt ---');
    expect(result).toContain(prompt);
  });

  test('should include user name when provided', () => {
    const prompt = 'This is a test prompt';
    const userData: UserContextData = {
      name: 'Test User'
    };

    const result = injectSituationalContext(prompt, userData);

    expect(result).toContain('User: Test User');
    expect(result).toContain(prompt);
  });

  test('should include user location when provided', () => {
    const prompt = 'This is a test prompt';
    const userData: UserContextData = {
      name: 'Test User',
      location: 'New York, NY'
    };

    const result = injectSituationalContext(prompt, userData);

    expect(result).toContain('User: Test User');
    expect(result).toContain('Location: New York, NY');
    expect(result).toContain(prompt);
  });

  test('should work with empty user data', () => {
    const prompt = 'This is a test prompt';
    const userData: UserContextData = {};

    const result = injectSituationalContext(prompt, userData);

    expect(result).not.toContain('User:');
    expect(result).not.toContain('Location:');
    expect(result).toContain(prompt);
  });

  test('should handle multiline prompts correctly', () => {
    const prompt = 'This is a test prompt\nWith multiple lines\nOf text';
    const result = injectSituationalContext(prompt);

    expect(result).toContain('--- Original Prompt ---');
    expect(result).toContain(prompt);
  });
});