import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { Bindings } from '../types';
import { fileAttachmentService } from '../services/fileAttachmentService';
import { ServiceError } from '@dome/common';
import { getLogger } from '@dome/logging';

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
    getLogger().info({ path: c.req.path, method: c.req.method }, 'File upload started');
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      getLogger().debug({ userId }, 'User ID extracted for file upload');
      
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
      getLogger().debug({}, 'Parsing multipart form data');
      const formData = await c.req.formData();
      const file = formData.get('file') as File | null;
      const title = formData.get('title') as string | null;
      
      if (!file) {
        getLogger().warn({ userId }, 'No file provided in upload request');
        return c.json({ error: 'No file provided' }, 400);
      }
      
      if (!title) {
        getLogger().warn({ userId }, 'No title provided in upload request');
        return c.json({ error: 'Title is required' }, 400);
      }
      
      // Get file data as ArrayBuffer
      getLogger().debug({
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size
      }, 'Processing uploaded file');
      const arrayBuffer = await file.arrayBuffer();
      
      // Attach file to note
      getLogger().info({
        userId,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size
      }, 'Attaching file to note');
      const note = await fileAttachmentService.attachFileToNote(
        c.env,
        userId,
        title,
        arrayBuffer,
        file.type,
        file.name
      );
      
      getLogger().info({
        noteId: note.id,
        fileName: file.name
      }, 'File successfully uploaded and attached to note');
      return c.json({ note }, 201);
    } catch (error) {
      getLogger().error({
        err: error,
        path: c.req.path,
        userId: c.req.header('x-user-id') || c.req.query('userId')
      }, 'Error uploading file');
      
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
    const noteId = c.req.param('id');
    getLogger().info({
      path: c.req.path,
      method: c.req.method,
      noteId
    }, 'File content processing started');
    
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      getLogger().debug({ userId, noteId }, 'User ID extracted for file processing');
      
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }
      
      // Process file content
      getLogger().info({ noteId }, 'Processing file content');
      const note = await fileAttachmentService.processFileContent(c.env, noteId);
      
      getLogger().info({ noteId }, 'File content successfully processed');
      return c.json({ note });
    } catch (error) {
      getLogger().error({
        err: error,
        noteId,
        path: c.req.path
      }, 'Error processing file content');
      
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
    const noteId = c.req.param('id');
    getLogger().info({
      path: c.req.path,
      method: c.req.method,
      noteId
    }, 'File attachment retrieval started');
    
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      getLogger().debug({ userId, noteId }, 'User ID extracted for file retrieval');
      
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }
      
      // Get file attachment
      getLogger().debug({ noteId }, 'Retrieving file attachment');
      const file = await fileAttachmentService.getFileAttachment(c.env, noteId);
      
      if (!file) {
        getLogger().info({ noteId }, 'File attachment not found');
        return c.json({ error: 'File not found' }, 404);
      }
      
      // Return file as stream
      getLogger().info({
        noteId,
        contentType: file.contentType
      }, 'File attachment successfully retrieved');
      
      return new Response(file.data, {
        headers: {
          'Content-Type': file.contentType
        }
      });
    } catch (error) {
      getLogger().error({
        err: error,
        noteId,
        path: c.req.path
      }, 'Error getting file attachment');
      
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
    const noteId = c.req.param('id');
    getLogger().info({
      path: c.req.path,
      method: c.req.method,
      noteId
    }, 'File attachment deletion started');
    
    try {
      // Get user ID from request headers or query parameters
      const userId = c.req.header('x-user-id') || c.req.query('userId');
      getLogger().debug({ userId, noteId }, 'User ID extracted for file deletion');
      
      if (!userId) {
        return c.json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'User ID is required. Provide it via x-user-id header or userId query parameter'
          }
        }, 401);
      }
      
      // Delete file attachment
      getLogger().info({ noteId }, 'Deleting file attachment');
      const deleted = await fileAttachmentService.deleteFileAttachment(c.env, noteId);
      
      if (!deleted) {
        getLogger().info({ noteId }, 'File attachment not found for deletion');
        return c.json({ error: 'File not found' }, 404);
      }
      
      getLogger().info({ noteId }, 'File attachment successfully deleted');
      return c.json({ success: true });
    } catch (error) {
      getLogger().error({
        err: error,
        noteId,
        path: c.req.path
      }, 'Error deleting file attachment');
      
      if (error instanceof ServiceError) {
        return c.json({ error: error.message }, 400);
      }
      
      return c.json({ error: 'Failed to delete file attachment' }, 500);
    }
  }
}

// Export singleton instance
export const fileController = new FileController();
