import { logError } from '@dome/common/logging';
import {
  DomeError,
  NotFoundError,
  ValidationError,
  InternalError,
  ForbiddenError, // Added for more variety
} from '@dome/errors';

// --- Test Runner Setup ---
interface TestCase {
  description: string;
  errorToLog: Error | DomeError;
  context?: Record<string, any>;
  expectedFields: Partial<Record<keyof LoggedError, any>> & {
    expectedContext?: Record<string, any>;
    errorNameShouldBe?: string;
    errorCodeShouldBe?: string;
  };
}

interface LoggedError {
  level: string;
  timestamp: string;
  serviceName?: string; // Assuming serviceName might be part of the log context
  requestId?: string; // Assuming requestId might be part of the log context
  errorMessage: string;
  errorName: string;
  errorStack?: string;
  errorCode?: string;
  errorDetails?: Record<string, any>;
  errorCause?: Record<string, any> | string;
  context?: Record<string, any>;
  [key: string]: any; // Allow other fields
}

let testsPassed = 0;
let testsFailed = 0;
const capturedLogs: LoggedError[] = [];

// Mock console.log to capture output
const originalConsoleLog = console.log;
console.log = (...args: any[]) => {
  try {
    // Assuming the first argument is the JSON string or object
    const logOutput = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
    if (logOutput && typeof logOutput === 'object' && 'errorMessage' in logOutput) {
      capturedLogs.push(logOutput as LoggedError);
    }
  } catch (e) {
    // If parsing fails, it might not be our structured log, or format is unexpected
    originalConsoleLog('Failed to parse log for test capture:', args, e);
  }
  originalConsoleLog.apply(console, args); // Still log to console for visibility
};

function runTest(testCase: TestCase) {
  originalConsoleLog(`\n--- Testing: ${testCase.description} ---`);
  capturedLogs.length = 0; // Clear previous logs

  try {
    logError(testCase.errorToLog, testCase.errorToLog.message, testCase.context);
  } catch (e: any) {
    originalConsoleLog(`ERROR DURING LOGGING: ${e.message}`);
    testsFailed++;
    originalConsoleLog(`Result: FAIL (Logging function threw an error)`);
    return;
  }

  if (capturedLogs.length === 0) {
    testsFailed++;
    originalConsoleLog(`Result: FAIL (No structured log captured)`);
    return;
  }

  const loggedEntry = capturedLogs[0];
  let pass = true;
  const mismatches: string[] = [];

  // Verify standard fields
  if (loggedEntry.level !== 'error') {
    pass = false;
    mismatches.push(`Expected level "error", got "${loggedEntry.level}"`);
  }
  if (!loggedEntry.timestamp) {
    pass = false;
    mismatches.push(`Expected timestamp to be present`);
  }
  if (loggedEntry.errorMessage !== testCase.errorToLog.message) {
    pass = false;
    mismatches.push(
      `Expected errorMessage "${testCase.errorToLog.message}", got "${loggedEntry.errorMessage}"`,
    );
  }

  const expectedErrorName = testCase.expectedFields.errorNameShouldBe || testCase.errorToLog.name;
  if (loggedEntry.errorName !== expectedErrorName) {
    pass = false;
    mismatches.push(`Expected errorName "${expectedErrorName}", got "${loggedEntry.errorName}"`);
  }

  if (testCase.errorToLog.stack && !loggedEntry.errorStack?.includes(testCase.errorToLog.message)) {
    // Stack check is lenient, just ensuring it's present and somewhat related
    pass = false;
    mismatches.push(`Expected errorStack to be present and contain error message`);
  }
  if (!testCase.errorToLog.stack && loggedEntry.errorStack) {
    pass = false;
    mismatches.push(`Expected no errorStack, but got one`);
  }

  // Verify DomeError specific fields
  if (testCase.errorToLog instanceof DomeError) {
    const expectedErrorCode =
      testCase.expectedFields.errorCodeShouldBe || (testCase.errorToLog as DomeError).code;
    if (loggedEntry.errorCode !== expectedErrorCode) {
      pass = false;
      mismatches.push(`Expected errorCode "${expectedErrorCode}", got "${loggedEntry.errorCode}"`);
    }
    if (
      JSON.stringify(loggedEntry.errorDetails) !==
      JSON.stringify((testCase.errorToLog as DomeError).details)
    ) {
      // Note: This is a simple stringify comparison. For complex objects, a deep equal might be better.
      pass = false;
      mismatches.push(
        `Expected errorDetails ${JSON.stringify(
          (testCase.errorToLog as DomeError).details,
        )}, got ${JSON.stringify(loggedEntry.errorDetails)}`,
      );
    }
  }

  // Verify cause
  const originalCause = (testCase.errorToLog as any).cause;
  if (originalCause) {
    if (!loggedEntry.errorCause) {
      pass = false;
      mismatches.push(`Expected errorCause to be present`);
    } else {
      // The logError utility might serialize the cause.
      // If originalCause is an Error, we expect its message or a serialized version.
      if (originalCause instanceof Error) {
        if (typeof loggedEntry.errorCause === 'string') {
          if (!loggedEntry.errorCause.includes(originalCause.message)) {
            pass = false;
            mismatches.push(
              `Expected errorCause to contain "${originalCause.message}", got "${loggedEntry.errorCause}"`,
            );
          }
        } else if (typeof loggedEntry.errorCause === 'object' && loggedEntry.errorCause !== null) {
          if ((loggedEntry.errorCause as any).message !== originalCause.message) {
            pass = false;
            mismatches.push(
              `Expected errorCause.message to be "${originalCause.message}", got "${
                (loggedEntry.errorCause as any).message
              }"`,
            );
          }
        } else {
          pass = false;
          mismatches.push(`Unexpected errorCause format: ${typeof loggedEntry.errorCause}`);
        }
      } else if (loggedEntry.errorCause !== originalCause) {
        // For non-Error causes, expect direct match (if simple type)
        pass = false;
        mismatches.push(`Expected errorCause "${originalCause}", got "${loggedEntry.errorCause}"`);
      }
    }
  } else if (loggedEntry.errorCause) {
    pass = false;
    mismatches.push(`Expected no errorCause, but got one`);
  }

  // Verify additional context
  if (testCase.context || testCase.expectedFields.expectedContext) {
    const expectedCtx = { ...testCase.context, ...testCase.expectedFields.expectedContext };
    for (const key in expectedCtx) {
      if (JSON.stringify(loggedEntry.context?.[key]) !== JSON.stringify(expectedCtx[key])) {
        pass = false;
        mismatches.push(
          `Expected context.${key} to be ${JSON.stringify(expectedCtx[key])}, got ${JSON.stringify(
            loggedEntry.context?.[key],
          )}`,
        );
      }
    }
  }

  if (pass) {
    testsPassed++;
    originalConsoleLog(`Result: PASS`);
  } else {
    testsFailed++;
    originalConsoleLog(`Result: FAIL`);
    mismatches.forEach(m => originalConsoleLog(`  - ${m}`));
    originalConsoleLog(`Logged Entry:`, JSON.stringify(loggedEntry, null, 2));
  }
}

// --- Test Cases ---

const testCases: TestCase[] = [
  {
    description: 'Standard JavaScript Error',
    errorToLog: new Error('This is a standard JS Error'),
    context: { operation: 'standardTest' },
    expectedFields: {
      errorNameShouldBe: 'Error',
      expectedContext: { operation: 'standardTest' },
    },
  },
  {
    description: 'Custom DomeError (InternalError)',
    errorToLog: new InternalError('This is an InternalError', { detail1: 'value1' }),
    context: { operation: 'domeErrorTest', userId: 123 },
    expectedFields: {
      errorNameShouldBe: 'InternalError',
      errorCodeShouldBe: 'INTERNAL_ERROR',
      expectedContext: { operation: 'domeErrorTest', userId: 123 },
    },
  },
  {
    description: 'Custom DomeError (NotFoundError)',
    errorToLog: new NotFoundError('Resource not found here', { resourceId: 'res404' }),
    expectedFields: {
      errorNameShouldBe: 'NotFoundError',
      errorCodeShouldBe: 'NOT_FOUND',
    },
  },
  {
    description: 'Custom DomeError (ValidationError)',
    errorToLog: new ValidationError('Invalid input provided', { field: 'email', issue: 'format' }),
    context: { formId: 'contactForm' },
    expectedFields: {
      errorNameShouldBe: 'ValidationError',
      errorCodeShouldBe: 'VALIDATION_ERROR',
      expectedContext: { formId: 'contactForm' },
    },
  },
  {
    description: 'Third-party error (simulated as plain Error with different name)',
    errorToLog: (() => {
      const err = new Error('Axios network error');
      err.name = 'AxiosError'; // Simulate a third-party error name
      (err as any).isAxiosError = true;
      (err as any).code = 'ECONNABORTED';
      return err;
    })(),
    context: { externalSystem: 'PaymentGateway' },
    expectedFields: {
      errorNameShouldBe: 'AxiosError', // logError should preserve the original name if possible
      expectedContext: { externalSystem: 'PaymentGateway' },
    },
  },
  {
    description: 'Error with a cause (standard Error)',
    errorToLog: (() => {
      const err = new Error('High-level error');
      (err as any).cause = new Error('Low-level root cause');
      return err;
    })(),
    context: { scenario: 'errorWithCause' },
    expectedFields: {
      errorNameShouldBe: 'Error',
      expectedContext: { scenario: 'errorWithCause' },
    },
  },
  {
    description: 'Error with a cause (DomeError causing DomeError)',
    errorToLog: new InternalError('Service A failed', {
      cause: new ForbiddenError('Access denied by Service B', { permission: 'read:data' }),
    }),
    context: { traceId: 'trace-abc-123' },
    expectedFields: {
      errorNameShouldBe: 'InternalError',
      errorCodeShouldBe: 'INTERNAL_ERROR',
      expectedContext: { traceId: 'trace-abc-123' },
    },
  },
  {
    description: 'Error without a stack trace (if possible to create)',
    errorToLog: (() => {
      const err = new Error('No stack here');
      err.stack = undefined; // Attempt to remove stack
      return err;
    })(),
    expectedFields: {
      errorNameShouldBe: 'Error',
    },
  },
  {
    description: 'Error with complex additional context',
    errorToLog: new ValidationError('Complex validation issue'),
    context: {
      userId: 99,
      requestData: { body: { name: 'Test', value: null }, headers: { 'X-Request-ID': 'req-789' } },
      attemptNumber: 3,
    },
    expectedFields: {
      errorNameShouldBe: 'ValidationError',
      errorCodeShouldBe: 'VALIDATION_ERROR',
      expectedContext: {
        userId: 99,
        requestData: {
          body: { name: 'Test', value: null },
          headers: { 'X-Request-ID': 'req-789' },
        },
        attemptNumber: 3,
      },
    },
  },
  {
    description: 'DomeError with no specific details in constructor',
    errorToLog: new NotFoundError('Minimal not found error'),
    context: { checkPoint: 'minimal' },
    expectedFields: {
      errorNameShouldBe: 'NotFoundError',
      errorCodeShouldBe: 'NOT_FOUND',
      expectedContext: { checkPoint: 'minimal' },
    },
  },
];

// --- Script Execution ---
originalConsoleLog('Starting Error Logging Validation Script...');
originalConsoleLog(
  'This script verifies that the `logError` utility produces standardized, structured logs.',
);
originalConsoleLog(
  'Expected output for each error includes fields like: errorMessage, errorName, errorStack, errorCode (for DomeErrors), errorDetails, errorCause, and any provided context.',
);
originalConsoleLog(
  'This ensures compliance with our error logging standardization efforts for improved debugging and monitoring.',
);

testCases.forEach(runTest);

originalConsoleLog(`\n--- Test Summary ---`);
originalConsoleLog(`Total Tests: ${testCases.length}`);
originalConsoleLog(`Passed: ${testsPassed}`);
originalConsoleLog(`Failed: ${testsFailed}`);

// Restore console.log
console.log = originalConsoleLog;

if (testsFailed > 0) {
  process.exit(1); // Exit with error code if any tests failed
} else {
  process.exit(0); // Exit successfully
}

/**
 * How to run this script:
 * -------------------------
 * 1. Ensure dependencies are installed: `pnpm install` (from the root of the monorepo)
 * 2. Compile TypeScript (if not already part of your build process for scripts):
 *    `pnpm exec tsc --project tsconfig.json scripts/validate-error-logging.ts` (adjust tsconfig path if needed)
 *    Alternatively, if you have a global `ts-node` or similar:
 *    `pnpm exec ts-node scripts/validate-error-logging.ts`
 * 3. Run the compiled JavaScript file:
 *    `node scripts/validate-error-logging.js`
 *    Or directly with ts-node:
 *    `pnpm exec ts-node scripts/validate-error-logging.ts`
 *
 * What this script verifies:
 * --------------------------
 * - That `logError` correctly processes different types of errors (standard JS, custom DomeErrors, third-party like).
 * - That essential information (message, name, stack, code for DomeErrors) is present in the log output.
 * - That `cause` information is captured and logged.
 * - That additional `context` provided to `logError` is included in the structured log.
 * - That the log output is in a parsable (JSON) format with expected top-level fields like `level: "error"`.
 *
 * Expected Log Structure (Example for a DomeError):
 * --------------------------------------------------
 * {
 *   "level": "error",
 *   "timestamp": "2023-10-27T10:30:00.123Z", // ISO 8601 format
 *   "serviceName": "your-service-name", // (If configured globally or in context)
 *   "requestId": "some-uuid-v4",      // (If available in context)
 *   "errorMessage": "Resource not found here",
 *   "errorName": "NotFoundError",
 *   "errorStack": "NotFoundError: Resource not found here\n    at /path/to/your/code.ts:12:34\n    ...",
 *   "errorCode": "NOT_FOUND",
 *   "errorDetails": { "resourceId": "res404" },
 *   "errorCause": { // (If a cause exists and is an Error object, might be serialized)
 *     "name": "OriginalError",
 *     "message": "The underlying issue",
 *     "stack": "OriginalError: The underlying issue\n    at ..."
 *   },
 *   "context": {
 *     "operation": "domeErrorTest",
 *     "userId": 123
 *     // Any other custom context provided
 *   }
 * }
 *
 * This script is crucial for:
 * 1. Initial validation of the `logError` standardization.
 * 2. Ongoing regression testing to ensure logging remains compliant.
 * 3. Providing clear examples of how `logError` should behave.
 */
