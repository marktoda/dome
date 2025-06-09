import { describe, it, expect, vi } from 'vitest';

import {
  generateId,
  generateShortId,
  retry,
  sleep,
  chunkArray,
  safeJsonParse,
  PerformanceTimer,
  isValidUrl,
  normalizeUrl,
  truncate,
  slugify,
  omit,
  pick,
  isErrorWithCode,
  getErrorMessage,
} from './index.js';

describe('Utils', () => {
  describe('generateId', () => {
    it('should generate a unique ID', () => {
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).not.toBe(id2);
      expect(id1).toHaveLength(32);
    });

    it('should generate ID with prefix', () => {
      const id = generateId('test');
      expect(id).toMatch(/^test_[a-f0-9]{32}$/);
    });
  });

  describe('generateShortId', () => {
    it('should generate a short unique ID', () => {
      const id = generateShortId();
      expect(id).toHaveLength(12);
      expect(id).toMatch(/^[a-f0-9]{12}$/);
    });
  });

  describe('retry', () => {
    it('should retry failed operations', async () => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Failed');
        }
        return 'success';
      });

      const result = await retry(fn, { maxAttempts: 3, delay: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw after max attempts', async () => {
      const fn = vi.fn(async () => {
        throw new Error('Always fails');
      });

      await expect(retry(fn, { maxAttempts: 2, delay: 10 })).rejects.toThrow('Always fails');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should call onRetry callback', async () => {
      const onRetry = vi.fn();
      const fn = vi.fn(async () => {
        throw new Error('Fail');
      });

      await expect(retry(fn, { maxAttempts: 2, delay: 10, onRetry })).rejects.toThrow();
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  describe('sleep', () => {
    it('should delay execution', async () => {
      const start = Date.now();
      await sleep(50);
      const duration = Date.now() - start;
      expect(duration).toBeGreaterThanOrEqual(45); // Allow some variance
    });
  });

  describe('chunkArray', () => {
    it('should split array into chunks', () => {
      const array = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      const chunks = chunkArray(array, 3);
      expect(chunks).toEqual([
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ]);
    });

    it('should handle arrays not divisible by chunk size', () => {
      const array = [1, 2, 3, 4, 5];
      const chunks = chunkArray(array, 2);
      expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('should handle empty array', () => {
      const chunks = chunkArray([], 3);
      expect(chunks).toEqual([]);
    });
  });

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      const result = safeJsonParse('{"test": true}');
      expect(result).toEqual({ test: true });
    });

    it('should return null for invalid JSON', () => {
      const result = safeJsonParse('invalid json');
      expect(result).toBeNull();
    });
  });

  describe('PerformanceTimer', () => {
    it('should measure duration', async () => {
      const timer = new PerformanceTimer();
      await sleep(50);
      const duration = timer.getDuration();
      expect(duration).toBeGreaterThanOrEqual(45);
    });

    it('should track marks', async () => {
      const timer = new PerformanceTimer();
      await sleep(20);
      timer.mark('step1');
      await sleep(20);
      timer.mark('step2');

      const duration = timer.getDuration('step1', 'step2');
      expect(duration).toBeGreaterThanOrEqual(15);
    });

    it('should get all marks', () => {
      const timer = new PerformanceTimer();
      timer.mark('step1');
      timer.mark('step2');

      const marks = timer.getMarks();
      expect(marks).toHaveProperty('step1');
      expect(marks).toHaveProperty('step2');
    });
  });

  describe('URL utilities', () => {
    it('should validate URLs', () => {
      expect(isValidUrl('https://example.com')).toBe(true);
      expect(isValidUrl('http://localhost:3000')).toBe(true);
      expect(isValidUrl('not a url')).toBe(false);
    });

    it('should normalize URLs', () => {
      expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
      expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
      expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path');
      expect(normalizeUrl('https://example.com/path/subpath/')).toBe(
        'https://example.com/path/subpath'
      );
    });
  });

  describe('String utilities', () => {
    it('should truncate strings', () => {
      expect(truncate('Hello World', 5)).toBe('He...');
      expect(truncate('Hi', 5)).toBe('Hi');
      expect(truncate('Hello World', 8, '…')).toBe('Hello W…');
    });

    it('should slugify strings', () => {
      expect(slugify('Hello World!')).toBe('hello-world');
      expect(slugify('  Multiple   Spaces  ')).toBe('multiple-spaces');
      expect(slugify('Special@#$Characters')).toBe('specialcharacters');
    });
  });

  describe('Object utilities', () => {
    it('should omit keys from object', () => {
      const obj = { a: 1, b: 2, c: 3 };
      expect(omit(obj, ['b'])).toEqual({ a: 1, c: 3 });
      expect(omit(obj, ['a', 'c'])).toEqual({ b: 2 });
    });

    it('should pick keys from object', () => {
      const obj = { a: 1, b: 2, c: 3 };
      expect(pick(obj, ['a', 'c'])).toEqual({ a: 1, c: 3 });
      expect(pick(obj, ['b'])).toEqual({ b: 2 });
    });
  });

  describe('Error utilities', () => {
    it('should check if error has code', () => {
      const errorWithCode = Object.assign(new Error('Test'), { code: 'TEST_ERROR' });
      const normalError = new Error('Test');

      expect(isErrorWithCode(errorWithCode)).toBe(true);
      expect(isErrorWithCode(normalError)).toBe(false);
    });

    it('should get error message', () => {
      expect(getErrorMessage(new Error('Test error'))).toBe('Test error');
      expect(getErrorMessage('String error')).toBe('String error');
      expect(getErrorMessage(123)).toBe('Unknown error');
      expect(getErrorMessage(null)).toBe('Unknown error');
    });
  });
});
