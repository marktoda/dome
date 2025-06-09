import crypto from 'crypto';

import type { z } from 'zod';

// ID generation
export const generateId = (prefix?: string): string => {
  const id = crypto.randomBytes(16).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
};

export const generateShortId = (): string => {
  return crypto.randomBytes(6).toString('hex');
};

// Retry utility
export interface RetryOptions {
  maxAttempts?: number;
  delay?: number;
  backoff?: 'linear' | 'exponential';
  onRetry?: (error: Error, attempt: number) => void;
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, delay = 1000, backoff = 'exponential', onRetry } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxAttempts) {
        throw lastError;
      }

      if (onRetry) {
        onRetry(lastError, attempt);
      }

      const waitTime =
        backoff === 'exponential' ? delay * Math.pow(2, attempt - 1) : delay * attempt;

      await sleep(waitTime);
    }
  }

  throw lastError!;
}

// Sleep utility
export const sleep = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

// Chunk array utility
export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Safe JSON parse
export function safeJsonParse<T>(json: string, schema?: z.ZodSchema<T>): T | null {
  try {
    const parsed = JSON.parse(json);
    if (schema) {
      return schema.parse(parsed);
    }
    return parsed;
  } catch {
    return null;
  }
}

// Performance measurement
export class PerformanceTimer {
  private startTime: number;
  private marks: Map<string, number> = new Map();

  constructor() {
    this.startTime = Date.now();
  }

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  getDuration(from?: string, to?: string): number {
    const fromTime = from ? this.marks.get(from) : this.startTime;
    const toTime = to ? this.marks.get(to) : Date.now();

    if (!fromTime) {
      throw new Error(`Mark "${from}" not found`);
    }
    if (to && !toTime) {
      throw new Error(`Mark "${to}" not found`);
    }

    return toTime! - fromTime;
  }

  getMarks(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [name, time] of this.marks) {
      result[name] = time - this.startTime;
    }
    return result;
  }
}

// URL utilities
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove trailing slash only if pathname is not just "/"
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    // Sort query parameters
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url;
  }
}

// String utilities
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - suffix.length) + suffix;
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Object utilities
export function omit<T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}

export function pick<T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

// Error utilities
export function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

// Environment utilities
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

export function getEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}
