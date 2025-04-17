import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Bindings } from '../types';
import { fileAttachmentService } from '../services/fileAttachmentService';
import { ServiceError } from '@dome/common';

/**
 * Controller for file operations
 */
export class FileController {
  /**
   * Upload a file and attach it to a note
   * @param c Hono context
   * @returns Response
   */
  async uploadFile(c: Context<{ Bindings: Bindings }>) {
    try {
      // Get user ID from request headers or query parameters
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
      
      // Parse multipart form data
      const formData = await c.req.formData();
      const file = formData.get('file') as File | null;
      const title = formData.get('title') as string | null;
      
      if (!file) {
        return c.json({ error: 'No file provided' }, 400);
      }
      
      if (!title) {
        return c.json({ error: 'Title is required' }, 400);
      }
      
      // Get file data as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();
      
      // Attach file to note
      const note = await fileAttachmentService.attachFileToNote(
        c.env,
        userId,
        title,
        arrayBuffer,
        file.type,
        file.name
      );
      
      return c.json({ note }, 201);
    } catch (error) {
      console.error('Error uploading file:', error);
      
      if (error instanceof ServiceError) {
        return c.json({ error: error.message }, 400);
      }
      
      return c.json({ error: 'Failed to upload file' }, 500);
    }
  }
  
  /**
   * Process file content for a note
   * @param c Hono context
   * @returns Response
   */
  async processFileContent(c: Context<{ Bindings: Bindings }>) {
    try {
      // Get user ID from request headers or query parameters
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
      
      // Get note ID from path
      const noteId = c.req.param('id');
      
      // Process file content
      const note = await fileAttachmentService.processFileContent(c.env, noteId);
      
      return c.json({ note });
    } catch (error) {
      console.error('Error processing file content:', error);
      
      if (error instanceof ServiceError) {
        return c.json({ error: error.message }, 400);
      }
      
      return c.json({ error: 'Failed to process file content' }, 500);
    }
  }
  
  /**
   * Get a file attachment
   * @param c Hono context
   * @returns Response
   */
  async getFileAttachment(c: Context<{ Bindings: Bindings }>) {
    try {
      // Get user ID from request headers or query parameters
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
      
      // Get note ID from path
      const noteId = c.req.param('id');
      
      // Get file attachment
      const file = await fileAttachmentService.getFileAttachment(c.env, noteId);
      
      if (!file) {
        return c.json({ error: 'File not found' }, 404);
      }
      
      // Return file as stream
      return new Response(file.data, {
        headers: {
          'Content-Type': file.contentType
        }
      });
    } catch (error) {
      console.error('Error getting file attachment:', error);
      
      if (error instanceof ServiceError) {
        return c.json({ error: error.message }, 400);
      }
      
      return c.json({ error: 'Failed to get file attachment' }, 500);
    }
  }
  
  /**
   * Delete a file attachment
   * @param c Hono context
   * @returns Response
   */
  async deleteFileAttachment(c: Context<{ Bindings: Bindings }>) {
    try {
      // Get user ID from request headers or query parameters
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
      
      // Get note ID from path
      const noteId = c.req.param('id');
      
      // Delete file attachment
      const deleted = await fileAttachmentService.deleteFileAttachment(c.env, noteId);
      
      if (!deleted) {
        return c.json({ error: 'File not found' }, 404);
      }
      
      return c.json({ success: true });
    } catch (error) {
      console.error('Error deleting file attachment:', error);
      
      if (error instanceof ServiceError) {
        return c.json({ error: error.message }, 400);
      }
      
      return c.json({ error: 'Failed to delete file attachment' }, 500);
    }
  }
}

// Export singleton instance
export const fileController = new FileController();
