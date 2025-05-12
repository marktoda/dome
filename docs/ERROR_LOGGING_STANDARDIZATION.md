# Error Logging Standardization Project

## 1. Project Overview

This document outlines the project to standardize error logging across the monorepo using a centralized `logError` utility function. The primary goal is to establish consistent, structured, and informative error logging practices. This standardization will improve our ability to monitor application health, debug issues more effectively, and perform centralized log analysis.

## 2. Current State

Currently, error logging is inconsistent across different services and scripts:

-   Backend services might use various logger instances (e.g., `pino`, `winston`) with methods like `logger.error()` or `logger.warn()`.
-   Standalone scripts and utility functions often use `console.error()`.
-   Log formats vary, often lacking structured data (like request IDs, user context, etc.).
-   Error objects are sometimes logged as strings (`error.message`) instead of full objects, losing stack trace information.

This inconsistency makes it difficult to:

-   Aggregate and search logs effectively across the system.
-   Build reliable monitoring dashboards and alerts.
-   Quickly understand the context of an error during debugging.

Standardizing on a single `logError` utility provides:

-   **Uniformity**: All errors are logged in the same structured format (likely JSON).
-   **Rich Context**: Ensures essential context (e.g., service name, request ID, custom metadata) is included with every error log.
-   **Improved Analysis**: Simplifies querying, filtering, and analyzing logs in our logging platform.
-   **Developer Experience**: Provides a clear and simple way to log errors correctly.

## 3. Implementation Approach

We have developed scripts to automate the transition to the standardized `logError` function. These scripts handle the replacement of existing logging patterns:

1.  **Backend Service Script**: Targets services (e.g., under `services/`) and replaces instances of `logger.error(...)` and `logger.warn(...)` with the appropriate `logError(...)` call. It aims to preserve existing context where possible and wrap the original error object.
2.  **Scripts/Utilities Script**: Targets files outside of backend services (e.g., in `scripts/`, `packages/`) and replaces instances of `console.error(...)` with `logError(...)`.

These scripts are designed to be run across the codebase to perform the necessary refactoring. The core `logError` utility likely resides in [`packages/common/src/utils/logError.ts`](packages/common/src/utils/logError.ts) (verify path if different).

## 4. Usage Instructions

Follow these steps to apply the standardization scripts:

1.  **Ensure Clean State**: Make sure your working directory is clean (`git status`). Commit or stash any pending changes.
2.  **Run the Scripts**: Execute the standardization scripts. Assuming a command is configured in `package.json` or `justfile`:
    ```bash
    # Example command (adjust if different)
    just standardize-error-logs 
    # Or potentially:
    # pnpm run standardize-error-logs
    ```
3.  **Dry Run (Optional but Recommended)**: Run the script in dry-run mode first to preview changes without modifying files:
    ```bash
    # Example command (adjust flags as needed)
    just standardize-error-logs --dry-run
    ```
4.  **Interactive Mode (Optional)**: Run in interactive mode to review and approve each change individually:
    ```bash
    # Example command (adjust flags as needed)
    just standardize-error-logs --interactive
    ```
5.  **Targeted Paths (Optional)**: Run the script on specific directories or files:
    ```bash
    # Example command (adjust flags as needed)
    just standardize-error-logs --path services/ingestor
    ```
6.  **Verify Changes**: After running the script (not in dry-run mode), carefully review the modifications using `git diff`. Pay attention to:
    -   Correct replacement of old logging calls.
    -   Preservation of the original error object.
    -   Inclusion of relevant context.
    -   Absence of unintended changes.
7.  **Run Linters/Tests**: Ensure the changes pass linting and all tests:
    ```bash
    pnpm run lint
    pnpm run test 
    # Or using just:
    # just lint
    # just test
    ```
8.  **Commit Changes**: Once satisfied, commit the changes with a clear message (e.g., `refactor: standardize error logging in [service/package]`).

## 5. Testing Plan

Thorough testing is crucial to ensure the standardization doesn't introduce regressions or negatively impact logging:

1.  **Local Verification**:
    -   Run services and scripts locally that have been modified.
    -   Manually trigger known error conditions (e.g., invalid input, failed external calls).
    -   Inspect the console output or local log files. Verify that errors are logged in the expected structured format (e.g., JSON) and contain fields like `level: "error"`, `error: { message: "...", stack: "..." }`, `context: { ... }`, `requestId` (if applicable).
2.  **Automated Tests**:
    -   Run the full test suite (`pnpm test` or `just test`). Ensure all existing tests pass.
    -   Consider adding specific tests that mock the `logError` function and verify it's called with the correct arguments in error scenarios.
3.  **Staging Environment Verification**:
    -   Deploy the changes to the staging environment.
    -   Monitor the logging platform (e.g., Datadog, Sentry) for logs from the updated services/scripts.
    -   Verify the structure and content of error logs match the new standard.
    -   Check that error rates and patterns are consistent with expectations (no sudden spikes or drops in logged errors).
    -   Perform exploratory testing on the staging application, focusing on error-prone paths.
4.  **Regression Checks**:
    -   Ensure that previously logged errors are still being captured.
    -   Confirm that application functionality related to error handling (e.g., user-facing error messages, retry mechanisms) remains unaffected.

## 6. Rollback Plan

If significant issues are discovered after applying the changes (e.g., broken functionality, incorrect logging, test failures that cannot be easily fixed), revert the changes using version control:

1.  **Identify Commits**: Find the commit(s) related to the error logging standardization.
2.  **Revert Changes**:
    -   If the changes are in the working directory and not committed: `git checkout -- .` (use with caution, reverts all uncommitted changes) or `git checkout -- <path/to/file>` for specific files.
    -   If the changes are committed: `git revert <commit-hash>` to create a new commit that undoes the changes, or `git reset --hard <commit-hash-before-changes>` (use with caution, rewrites history).
3.  **Communicate**: Inform the team about the rollback and the reasons for it.

## 7. Best Practices for Error Logging (`logError`)

To maintain consistency moving forward, adhere to these best practices when logging errors:

1.  **When to Use `logError`**:
    -   Log any unexpected error that occurs during operation (e.g., failed database query, network error, unhandled exception).
    -   Log significant operational failures or conditions that require attention, even if they are handled gracefully (e.g., failing to process a critical message after retries).
    -   Use it in `catch` blocks for errors that shouldn't have happened or indicate a potential bug.
    -   Avoid using `logError` for expected conditions or control flow (e.g., user input validation errors that are handled and returned to the user – use `logger.info` or `logger.debug` for these if logging is needed).

2.  **Format and Parameters**:
    -   The primary argument should always be the `Error` object itself. This ensures the message, stack trace, and any custom properties are captured.
    -   The second (optional) argument is a `context` object containing relevant key-value pairs. This provides additional information for debugging.
    ```typescript
    import { logError } from '@common/utils/logError'; // Adjust import path if needed

    try {
      // ... operation that might fail ...
    } catch (error: unknown) {
      if (error instanceof Error) {
        logError(error, { 
          context: 'Specific operation failed', 
          userId: user?.id, 
          resourceId: resource.id,
          // Add any other relevant context
        });
      } else {
        // Handle non-Error throws if necessary, though standardizing on Errors is best
        logError(new Error('Caught non-Error throwable'), { originalValue: String(error) });
      }
      // Re-throw or handle the error appropriately
    }
    ```

3.  **Examples of Good Usage**:

    ```typescript
    // Example 1: Catching a generic error
    try {
      await processUserData(userId);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logError(error, { context: 'Failed to process user data', userId });
      }
      // Handle or re-throw
    }

    // Example 2: Logging an error during an API call
    try {
      const response = await externalService.fetchData(itemId);
      if (!response.ok) {
        throw new Error(`External service failed with status ${response.status}`);
      }
    } catch (error: unknown) {
       if (error instanceof Error) {
         logError(error, { context: 'External service call failed', itemId });
       }
       // Handle or re-throw
    }
    
    // Example 3: Creating a new error for a specific condition
    if (!isValidConfiguration(config)) {
      const configError = new Error('Invalid service configuration detected');
      logError(configError, { context: 'Service startup check', configKeys: Object.keys(config) });
      throw configError; // Or handle appropriately
    }
    ```

4.  **What NOT to Log in Context**:
    -   Avoid logging sensitive information directly (passwords, API keys, raw PII) unless absolutely necessary and properly masked or secured.
    -   Keep context concise and relevant to the error. Avoid logging excessively large objects.

By following these guidelines, we can ensure our error logging remains consistent, informative, and valuable for maintaining system health.