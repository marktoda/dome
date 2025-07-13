/**
 * Zod schemas for context validation
 */

import { z } from 'zod';
import type { DomeContext, ValidationResult, ValidationError, ValidationWarning } from './types.js';

/**
 * Schema for template configuration
 */
export const templateSchema = z.object({
  frontmatter: z.record(z.any()).optional(),
  content: z.string().optional(),
}).optional();

/**
 * Schema for context rules
 */
export const rulesSchema = z.object({
  fileNaming: z.string().optional(),
  requiredFields: z.array(z.string()).optional(),
  autoTags: z.array(z.string()).optional(),
}).optional();

/**
 * Main schema for DomeContext
 */
export const domeContextSchema = z.object({
  name: z.string().min(1, 'Context name is required'),
  description: z.string().min(1, 'Context description is required'),
  template: templateSchema,
  rules: rulesSchema,
  aiInstructions: z.string().optional(),
});

/**
 * Validate a context object
 */
export function validateContext(data: unknown): { success: true; data: DomeContext } | { success: false; errors: z.ZodError } {
  const result = domeContextSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
}

/**
 * Convert Zod errors to ValidationResult format
 */
export function zodErrorsToValidationResult(zodError: z.ZodError): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  for (const issue of zodError.issues) {
    const path = issue.path.join('.');
    
    errors.push({
      type: 'other',
      message: `${path ? `${path}: ` : ''}${issue.message}`,
      field: path || undefined,
    });
  }

  return {
    isValid: false,
    errors,
    warnings,
  };
}

/**
 * Validate file naming pattern
 */
export function validateFileNamingPattern(pattern: string): boolean {
  // Check for valid placeholders
  const validPlaceholders = ['{title}', '{date}', '{time}', '{uuid}'];
  const placeholderRegex = /\{[^}]+\}/g;
  const foundPlaceholders = pattern.match(placeholderRegex) || [];
  
  for (const placeholder of foundPlaceholders) {
    if (!validPlaceholders.includes(placeholder)) {
      return false;
    }
  }
  
  // Check for date format patterns
  const datePatterns = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'];
  for (const datePattern of datePatterns) {
    if (pattern.includes(datePattern)) {
      // Basic validation - just ensure it's not in a placeholder
      const inPlaceholder = foundPlaceholders.some(p => p.includes(datePattern));
      if (!inPlaceholder) {
        return true;
      }
    }
  }
  
  return true;
}

/**
 * Parse and validate a raw YAML context file
 */
export function parseContextYaml(yamlContent: any): { success: true; data: DomeContext } | { success: false; error: ValidationResult } {
  const validationResult = validateContext(yamlContent);
  
  if (!validationResult.success) {
    return {
      success: false,
      error: zodErrorsToValidationResult(validationResult.errors),
    };
  }
  
  // Additional validation for file naming pattern
  if (validationResult.data.rules?.fileNaming) {
    if (!validateFileNamingPattern(validationResult.data.rules.fileNaming)) {
      return {
        success: false,
        error: {
          isValid: false,
          errors: [{
            type: 'invalid_filename',
            message: 'Invalid file naming pattern. Valid placeholders: {title}, {date}, {time}, {uuid}',
            field: 'rules.fileNaming',
          }],
          warnings: [],
        },
      };
    }
  }
  
  return { success: true, data: validationResult.data };
}