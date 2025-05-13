import { DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk'; // Use package import

/**
 * Defines the output format for error messages.
 */
export enum OutputFormat {
  CLI = 'cli',
  JSON = 'json',
}

/**
 * Interface for structured error details, primarily for JSON output.
 */
export interface ErrorDetails {
  type: string;
  message: string;
  statusCode?: number;
  details?: any; // To store additional error information, like API response body
}

/**
 * Options for the handleError utility.
 */
export interface HandleErrorOptions {
  outputFormat?: OutputFormat;
  // Future options could include a custom logger
}

/**
 * Handles errors consistently across the CLI.
 *
 * @param error - The error object to handle (can be of unknown type).
 * @param options - Configuration options for error handling, like output format.
 */
export function handleError(error: unknown, options: HandleErrorOptions = {}): void {
  const { outputFormat = OutputFormat.CLI } = options;
  let errorDetails: ErrorDetails;

  // Enhanced debugging - always log the raw error object
  console.error('DEBUG - Raw error:');
  console.error('Type:', typeof error);
  
  if (typeof error === 'object' && error !== null) {
    console.error('Properties:');
    for (const key in error) {
      try {
        console.error(`- ${key}:`, (error as any)[key]);
      } catch (e) {
        console.error(`- ${key}: [Error accessing property]`);
      }
    }
    
    if (error instanceof Error) {
      console.error('Name:', error.name);
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);
    }
  } else {
    console.error('Value:', error);
  }

  if (error instanceof DomeApiError) {
    const statusCode = error.statusCode;
    // Attempt to get a more specific message from the error body
    const message =
      (typeof error.body === 'object' && error.body !== null && 'message' in error.body && typeof error.body.message === 'string'
        ? error.body.message
        : error.message) || 'An API error occurred';

    errorDetails = {
      type: 'DomeApiError',
      message,
      statusCode,
      details: error.body, // Include the full body for detailed JSON output
    };
  } else if (error instanceof DomeApiTimeoutError) {
    errorDetails = {
      type: 'DomeApiTimeoutError',
      message: error.message || 'The API request timed out.',
      details: {} // No body property on DomeApiTimeoutError
    };
  } else if (error instanceof Error) {
    errorDetails = {
      type: 'GenericError',
      message: error.message,
      details: {
        name: error.name,
        stack: error.stack, // Include stack for generic errors in JSON
      },
    };
  } else {
    errorDetails = {
      type: 'UnknownError',
      message: typeof error === 'string' ? error : 'An unknown error occurred. Please check the details.',
      details: error, // Store the original unknown error
    };
  }

  if (outputFormat === OutputFormat.JSON) {
    // Output structured JSON to stderr
    console.error(JSON.stringify(errorDetails, null, 2));
  } else {
    // Regular CLI output to stderr
    console.error(`Error: ${errorDetails.message}`);
    if (errorDetails.statusCode) {
      console.error(`Status Code: ${errorDetails.statusCode}`);
    }
    // Optionally, provide a hint for more details if available and not too verbose
    if (errorDetails.type === 'DomeApiError' && errorDetails.details && Object.keys(errorDetails.details).length > 0) {
      // console.error(`Details: ${JSON.stringify(errorDetails.details)}`); // Could be too verbose
      // For CLI, a simpler message or specific fields might be better
      if (typeof errorDetails.details === 'object' && errorDetails.details !== null && 'error' in errorDetails.details) {
         const specificError = (errorDetails.details as any).error;
         if (typeof specificError === 'object' && specificError !== null && 'message' in specificError) {
            // console.error(`API Detail: ${specificError.message}`);
         } else if (typeof specificError === 'string') {
            // console.error(`API Detail: ${specificError}`);
         }
      }
    }
  }
  // The calling command should decide whether to exit.
  // This utility focuses on formatting and logging the error.
}