import { Request, Response, NextFunction } from 'express';
import { validationResult, ValidationChain } from 'express-validator';
import { ValidationError } from '../../utils/errors';

/**
 * Middleware to validate request data using express-validator
 * Checks for validation errors and returns a standardized error response
 */
export const validate = (validations: ValidationChain[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Execute all validations
    await Promise.all(validations.map(validation => validation.run(req)));
    
    // Check for validation errors
    const errors = validationResult(req);
    
    if (errors.isEmpty()) {
      return next();
    }
    
    // Format validation errors
    const formattedErrors = errors.array().map(error => ({
      field: 'type' in error && error.type === 'field' ? error.path : String(error.type || 'unknown'),
      message: error.msg,
      value: 'type' in error && error.type === 'field' ? error.value : undefined,
    }));
    
    // Create validation error with details
    const validationError = new ValidationError('Validation failed', {
      errors: formattedErrors,
    });
    
    next(validationError);
  };
};

/**
 * Schema validation middleware factory
 * Creates middleware that validates request data against a schema
 * 
 * @param schema The validation schema
 * @param location Where to look for the data (body, params, query, headers)
 */
export const validateSchema = (schema: any, location: 'body' | 'params' | 'query' | 'headers' = 'body') => {
  return (req: Request, res: Response, next: NextFunction) => {
    const data = req[location];
    const { error, value } = schema.validate(data, {
      abortEarly: false,
      stripUnknown: true,
    });
    
    if (error) {
      // Format validation errors
      const formattedErrors = error.details.map((detail: any) => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value,
      }));
      
      // Create validation error with details
      const validationError = new ValidationError('Validation failed', {
        errors: formattedErrors,
      });
      
      return next(validationError);
    }
    
    // Replace request data with validated data
    req[location] = value;
    next();
  };
};

/**
 * Phone number validation regex
 * Matches international phone numbers with optional + prefix
 */
export const PHONE_NUMBER_REGEX = /^\+?[1-9]\d{1,14}$/;

/**
 * Common validation schemas
 */
export const validationSchemas = {
  // Authentication schemas
  auth: {
    sendCode: {
      body: {
        phoneNumber: { type: 'string', pattern: PHONE_NUMBER_REGEX.source, required: true },
      },
    },
    verifyCode: {
      body: {
        phoneNumber: { type: 'string', pattern: PHONE_NUMBER_REGEX.source, required: true },
        phoneCode: { type: 'string', minLength: 1, maxLength: 10, required: true },
        phoneCodeHash: { type: 'string', required: true },
      },
    },
    refresh: {
      body: {
        refreshToken: { type: 'string', required: true },
      },
    },
  },
  
  // Session schemas
  sessions: {
    getById: {
      params: {
        sessionId: { type: 'string', required: true },
      },
    },
    getByUser: {
      params: {
        userId: { type: 'string', required: true },
      },
    },
  },
  
  // Message schemas
  messages: {
    getMessages: {
      params: {
        chatId: { type: 'string', required: true },
      },
      query: {
        limit: { type: 'number', min: 1, max: 100, default: 50 },
        cursor: { type: 'string' },
      },
    },
    sendMessage: {
      params: {
        chatId: { type: 'string', required: true },
      },
      body: {
        message: { type: 'string', minLength: 1, required: true },
      },
    },
    pollMessages: {
      params: {
        chatId: { type: 'string', required: true },
      },
      query: {
        limit: { type: 'number', min: 1, max: 100, default: 50 },
        timeout: { type: 'number', min: 1, max: 30, default: 10 },
      },
    },
  },
};