import { describe, it, expect, beforeEach, afterEach, vi, SpyInstance } from 'vitest';
import { handleError, OutputFormat, ErrorDetails } from './errorHandler';
import { DomeApiError, DomeApiTimeoutError } from '../../../dome-sdk/errors';

describe('handleError', () => {
  let consoleErrorSpy: SpyInstance;

  beforeEach(() => {
    // Mock console.error before each test
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore console.error after each test
    consoleErrorSpy.mockRestore();
  });

  // Test cases for DomeApiError
  describe('when handling DomeApiError', () => {
    const statusCode = 400;
    const apiErrorMessage = 'API request failed';
    const errorBodyWithMessage = { message: 'Detailed API error from body' };
    const errorBodyWithoutMessage = { detail: 'Some other detail' };

    it('should output in CLI format with message from error.body if available', () => {
      const apiError = new DomeApiError({
        message: apiErrorMessage,
        statusCode,
        body: errorBodyWithMessage,
      });
      handleError(apiError, { outputFormat: OutputFormat.CLI });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, `Error: ${errorBodyWithMessage.message}`);
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(2, `Status Code: ${statusCode}`);
    });

    it('should output in CLI format with primary error message if error.body.message is not available', () => {
      const apiError = new DomeApiError({
        message: apiErrorMessage,
        statusCode,
        body: errorBodyWithoutMessage,
      });
      handleError(apiError, { outputFormat: OutputFormat.CLI });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, `Error: ${apiErrorMessage}`);
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(2, `Status Code: ${statusCode}`);
    });

    it('should output in CLI format with default message if no message is provided', () => {
      const apiError = new DomeApiError({
        statusCode,
        body: {},
      });
      handleError(apiError, { outputFormat: OutputFormat.CLI });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, `Error: An API error occurred`);
      expect(consoleErrorSpy).toHaveBeenNthCalledWith(2, `Status Code: ${statusCode}`);
    });

    it('should output in JSON format with details from error.body', () => {
      const apiError = new DomeApiError({
        message: apiErrorMessage,
        statusCode,
        body: errorBodyWithMessage,
      });
      handleError(apiError, { outputFormat: OutputFormat.JSON });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const expectedDetails: ErrorDetails = {
        type: 'DomeApiError',
        message: errorBodyWithMessage.message,
        statusCode,
        details: errorBodyWithMessage,
      };
      expect(JSON.parse(consoleErrorSpy.mock.calls[0][0])).toEqual(expectedDetails);
    });

    it('should output in JSON format with primary error message if error.body.message is not available', () => {
        const apiError = new DomeApiError({
          message: apiErrorMessage,
          statusCode,
          body: errorBodyWithoutMessage,
        });
        handleError(apiError, { outputFormat: OutputFormat.JSON });
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        const expectedDetails: ErrorDetails = {
          type: 'DomeApiError',
          message: apiErrorMessage,
          statusCode,
          details: errorBodyWithoutMessage,
        };
        expect(JSON.parse(consoleErrorSpy.mock.calls[0][0])).toEqual(expectedDetails);
      });
  });

  // Test cases for DomeApiTimeoutError
  describe('when handling DomeApiTimeoutError', () => {
    const timeoutErrorMessage = 'Request timed out';

    it('should output in CLI format', () => {
      const timeoutError = new DomeApiTimeoutError(timeoutErrorMessage);
      handleError(timeoutError, { outputFormat: OutputFormat.CLI });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(`Error: ${timeoutErrorMessage}`);
    });

    it('should output in CLI format with default message if no message is provided', () => {
      // Provide an empty string, assuming the constructor or handler provides a default
      const timeoutError = new DomeApiTimeoutError('');
      handleError(timeoutError, { outputFormat: OutputFormat.CLI });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      // The errorHandler provides the default message "The API request timed out." when error.message is falsy
      expect(consoleErrorSpy).toHaveBeenCalledWith(`Error: The API request timed out.`);
    });

    it('should output in JSON format', () => {
      const timeoutError = new DomeApiTimeoutError(timeoutErrorMessage);
      handleError(timeoutError, { outputFormat: OutputFormat.JSON });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const expectedDetails: ErrorDetails = {
        type: 'DomeApiTimeoutError',
        message: timeoutErrorMessage,
        details: {},
      };
      expect(JSON.parse(consoleErrorSpy.mock.calls[0][0])).toEqual(expectedDetails);
    });
  });

  // Test cases for Generic Error
  describe('when handling Generic Error', () => {
    const genericErrorMessage = 'Something went wrong';
    const errorStack = 'Error: Something went wrong\n    at <anonymous>:1:1';

    it('should output in CLI format', () => {
      const genericError = new Error(genericErrorMessage);
      handleError(genericError, { outputFormat: OutputFormat.CLI });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(`Error: ${genericErrorMessage}`);
    });

    it('should output in JSON format with stack trace', () => {
      const genericError = new Error(genericErrorMessage);
      genericError.stack = errorStack;
      handleError(genericError, { outputFormat: OutputFormat.JSON });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const expectedDetails: ErrorDetails = {
        type: 'GenericError',
        message: genericErrorMessage,
        details: {
          stack: errorStack,
        },
      };
      expect(JSON.parse(consoleErrorSpy.mock.calls[0][0])).toEqual(expectedDetails);
    });
  });

  // Test cases for Unknown Error
  describe('when handling Unknown Error', () => {
    const unknownError = { customError: 'This is a strange error' };
    const defaultUnknownMessage = 'An unknown error occurred. Please check the details.';

    it('should output in CLI format', () => {
      handleError(unknownError, { outputFormat: OutputFormat.CLI });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(`Error: ${defaultUnknownMessage}`);
    });

    it('should output in JSON format with the original error as details', () => {
      handleError(unknownError, { outputFormat: OutputFormat.JSON });
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const expectedDetails: ErrorDetails = {
        type: 'UnknownError',
        message: defaultUnknownMessage,
        details: unknownError,
      };
      expect(JSON.parse(consoleErrorSpy.mock.calls[0][0])).toEqual(expectedDetails);
    });

    it('should handle string as unknown error in CLI format', () => {
        const stringError = "Just a string error";
        handleError(stringError, { outputFormat: OutputFormat.CLI });
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(`Error: ${defaultUnknownMessage}`);
    });

    it('should handle string as unknown error in JSON format', () => {
        const stringError = "Just a string error";
        handleError(stringError, { outputFormat: OutputFormat.JSON });
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        const expectedDetails: ErrorDetails = {
          type: 'UnknownError',
          message: defaultUnknownMessage,
          details: stringError,
        };
        expect(JSON.parse(consoleErrorSpy.mock.calls[0][0])).toEqual(expectedDetails);
    });
  });

  // Test default output format
  describe('when no output format is specified', () => {
    it('should default to CLI format', () => {
      const genericError = new Error('Default format test');
      handleError(genericError); // No options object passed
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(`Error: Default format test`);
    });
  });
});