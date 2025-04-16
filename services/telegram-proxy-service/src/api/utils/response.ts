import type { Response } from 'express';

/**
 * Standard API response interface
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta?: {
    [key: string]: any;
  };
}

/**
 * Send a success response
 *
 * @param res Express response object
 * @param data Response data
 * @param meta Optional metadata
 * @param statusCode HTTP status code (default: 200)
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  meta?: Record<string, any>,
  statusCode = 200,
): void {
  const response: ApiResponse<T> = {
    success: true,
    data,
  };

  if (meta) {
    response.meta = meta;
  }

  res.status(statusCode).json(response);
}

/**
 * Send an error response
 *
 * @param res Express response object
 * @param code Error code
 * @param message Error message
 * @param details Optional error details
 * @param statusCode HTTP status code (default: 400)
 */
export function sendError(
  res: Response,
  code: string,
  message: string,
  details?: any,
  statusCode = 400,
): void {
  const response: ApiResponse = {
    success: false,
    error: {
      code,
      message,
    },
  };

  if (details) {
    response.error!.details = details;
  }

  res.status(statusCode).json(response);
}

/**
 * Send a created response (201 Created)
 *
 * @param res Express response object
 * @param data Response data
 * @param meta Optional metadata
 */
export function sendCreated<T>(res: Response, data: T, meta?: Record<string, any>): void {
  sendSuccess(res, data, meta, 201);
}

/**
 * Send a no content response (204 No Content)
 *
 * @param res Express response object
 */
export function sendNoContent(res: Response): void {
  res.status(204).end();
}

/**
 * Send a paginated response
 *
 * @param res Express response object
 * @param data Response data
 * @param page Current page number
 * @param limit Items per page
 * @param total Total number of items
 * @param statusCode HTTP status code (default: 200)
 */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  page: number,
  limit: number,
  total: number,
  statusCode = 200,
): void {
  const totalPages = Math.ceil(total / limit);

  sendSuccess(
    res,
    data,
    {
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
      },
    },
    statusCode,
  );
}

/**
 * Send a cursor-paginated response
 *
 * @param res Express response object
 * @param data Response data
 * @param cursor Current cursor
 * @param nextCursor Next cursor (null if no more items)
 * @param count Number of items returned
 * @param statusCode HTTP status code (default: 200)
 */
export function sendCursorPaginated<T>(
  res: Response,
  data: T[],
  cursor: string | null,
  nextCursor: string | null,
  count: number,
  statusCode = 200,
): void {
  sendSuccess(
    res,
    data,
    {
      pagination: {
        cursor,
        nextCursor,
        count,
        hasMore: nextCursor !== null,
      },
    },
    statusCode,
  );
}
