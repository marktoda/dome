import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Bindings } from '../types';
import { searchService, NoteSearchResult } from '../services/searchService';
import { ServiceError } from '@dome/common';

/**
 * Search query validation schema
 */
const searchQuerySchema = z.object({
  q: z.string().min(1, 'Search query is required'),
  limit: z.coerce.number().int().positive().optional(),
  contentType: z.string().optional(),
  startDate: z.coerce.number().int().optional(),
  endDate: z.coerce.number().int().optional()
});

/**
 * Search controller
 */
export class SearchController {
  /**
   * Search notes
   * @param c Hono context
   * @returns Search results
   */
  static async search(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Validate query parameters
      const query = c.req.query();
      const validatedQuery = searchQuerySchema.parse(query);
      
      // Get user ID from request headers or query parameters
      // This is a temporary solution for development purposes
      // In production, this would come from proper authentication
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }
      
      // Perform search
      const searchResults = await searchService.search(c.env, {
        userId,
        query: validatedQuery.q,
        limit: validatedQuery.limit,
        contentType: validatedQuery.contentType,
        startDate: validatedQuery.startDate,
        endDate: validatedQuery.endDate
      });
      
      // Return search results
      return c.json({
        success: true,
        results: searchResults,
        count: searchResults.length,
        query: validatedQuery.q
      });
    } catch (error) {
      console.error('Error in search controller:', error);
      
      if (error instanceof z.ZodError) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid search parameters',
            details: error.errors
          }
        }, 400);
      }
      
      if (error instanceof ServiceError) {
        return c.json({
          success: false,
          error: {
            code: 'SEARCH_ERROR',
            message: error.message
          }
        }, 500);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred during search'
        }
      }, 500);
    }
  }
  
  /**
   * Stream search results
   * @param c Hono context
   * @returns Streamed search results
   */
  static async streamSearch(c: Context<{ Bindings: Bindings }>): Promise<Response> {
    try {
      // Validate query parameters
      const query = c.req.query();
      const validatedQuery = searchQuerySchema.parse(query);
      
      // Get user ID from request headers or query parameters
      // This is a temporary solution for development purposes
      // In production, this would come from proper authentication
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }
      
      // Create a TransformStream for streaming results
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      
      // Start search in the background
      (async () => {
        try {
          // Perform search
          const searchResults = await searchService.search(c.env, {
            userId,
            query: validatedQuery.q,
            limit: validatedQuery.limit,
            contentType: validatedQuery.contentType,
            startDate: validatedQuery.startDate,
            endDate: validatedQuery.endDate
          });
          
          // Stream each result as it becomes available
          for (const result of searchResults) {
            const resultJson = JSON.stringify(result) + '\n';
            await writer.write(new TextEncoder().encode(resultJson));
          }
          
          // Close the stream
          await writer.close();
        } catch (error) {
          console.error('Error in stream search:', error);
          
          // Write error to stream
          const errorJson = JSON.stringify({
            error: {
              code: 'SEARCH_ERROR',
              message: error instanceof Error ? error.message : 'An unexpected error occurred'
            }
          }) + '\n';
          
          await writer.write(new TextEncoder().encode(errorJson));
          await writer.close();
        }
      })();
      
      // Return the readable stream
      return new Response(readable, {
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Transfer-Encoding': 'chunked'
        }
      });
    } catch (error) {
      console.error('Error in stream search controller:', error);
      
      if (error instanceof z.ZodError) {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid search parameters',
            details: error.errors
          }
        }, 400);
      }
      
      return c.json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred during search'
        }
      }, 500);
    }
  }
}