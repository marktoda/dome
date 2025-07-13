/**
 * Tests for context schema validation
 */

import { TestRunner, assert, assertEqual } from './test-runner.js';
import { 
  domeContextSchema, 
  validateContext, 
  validateFileNamingPattern,
  zodErrorsToValidationResult 
} from '../../mastra/core/context/schema.js';

const runner = new TestRunner();

runner.test('validates valid context', () => {
  const validContext = {
    name: 'Test Context',
    description: 'A test context',
    template: {
      frontmatter: { tags: ['test'] },
      content: '# {title}'
    },
    rules: {
      fileNaming: 'YYYY-MM-DD-{title}',
      requiredFields: ['author'],
      autoTags: ['test-tag']
    },
    aiInstructions: 'Test instructions'
  };
  
  const result = validateContext(validContext);
  assert(result.success, 'Should validate valid context');
});

runner.test('rejects context without required fields', () => {
  const invalidContext = {
    description: 'Missing name'
  };
  
  const result = validateContext(invalidContext);
  assert(!result.success, 'Should reject context without name');
});

runner.test('validates minimal context', () => {
  const minimalContext = {
    name: 'Minimal',
    description: 'A minimal context'
  };
  
  const result = validateContext(minimalContext);
  assert(result.success, 'Should validate minimal context');
});

runner.test('validates file naming patterns', () => {
  assert(
    validateFileNamingPattern('YYYY-MM-DD-{title}'),
    'Should validate date pattern with title'
  );
  
  assert(
    validateFileNamingPattern('{date}-{title}'),
    'Should validate placeholder pattern'
  );
  
  assert(
    !validateFileNamingPattern('{invalid}'),
    'Should reject invalid placeholder'
  );
});

runner.test('converts Zod errors to ValidationResult', () => {
  const invalidContext = { name: '' }; // Missing description, empty name
  const result = domeContextSchema.safeParse(invalidContext);
  
  assert(!result.success, 'Should fail validation');
  
  if (!result.success) {
    const validationResult = zodErrorsToValidationResult(result.error);
    assert(!validationResult.isValid, 'Should be invalid');
    assert(validationResult.errors.length > 0, 'Should have errors');
  }
});

// Run tests
runner.run();