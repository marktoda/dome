import { Bindings } from '../types';
import { ServiceError } from '@dome/common';
import { r2Service } from './r2Service';

/**
 * Supported file types for content extraction
 */
export enum FileType {
  TEXT = 'text',
  PDF = 'pdf',
  IMAGE = 'image',
  UNKNOWN = 'unknown'
}

/**
 * File metadata interface
 */
export interface FileMetadata {
  contentType: string;
  fileType: FileType;
  size: number;
  pages?: number;
  extractedText?: string;
  additionalMetadata?: Record<string, any>;
}

/**
 * Processed file result
 */
export interface ProcessedFile {
  r2Key: string;
  metadata: FileMetadata;
  chunks?: string[];
}

/**
 * Service for processing files
 */
export class FileProcessingService {
  // Maximum size for direct processing (32KB)
  private readonly MAX_DIRECT_PROCESSING_SIZE = 32 * 1024;
  
  // Maximum chunk size for text processing (4KB)
  private readonly MAX_CHUNK_SIZE = 4 * 1024;
  
  /**
   * Detect file type from content type
   * @param contentType Content type
   * @returns FileType
   */
  detectFileType(contentType: string): FileType {
    const normalizedContentType = contentType.toLowerCase();
    
    if (normalizedContentType.startsWith('text/') || 
        normalizedContentType === 'application/json' ||
        normalizedContentType === 'application/xml') {
      return FileType.TEXT;
    }
    
    if (normalizedContentType === 'application/pdf') {
      return FileType.PDF;
    }
    
    if (normalizedContentType.startsWith('image/')) {
      return FileType.IMAGE;
    }
    
    return FileType.UNKNOWN;
  }
  
  /**
   * Process a file and extract content
   * @param env Environment bindings
   * @param data File data
   * @param contentType Content type
   * @param fileName Optional file name
   * @returns Promise with processed file result
   */
  async processFile(
    env: Bindings,
    data: ReadableStream | ArrayBuffer | string,
    contentType: string,
    fileName?: string
  ): Promise<ProcessedFile> {
    try {
      // Generate a unique key for R2 storage
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 10);
      const fileExtension = this.getFileExtension(contentType, fileName);
      const r2Key = `files/${timestamp}-${randomSuffix}${fileExtension}`;
      
      // Detect file type
      const fileType = this.detectFileType(contentType);
      
      // Upload to R2
      await r2Service.uploadObject(env, r2Key, data, contentType);
      
      // Initialize metadata
      const metadata: FileMetadata = {
        contentType,
        fileType,
        size: typeof data === 'string' ? new TextEncoder().encode(data).length : 
              data instanceof ArrayBuffer ? data.byteLength : 0, // For ReadableStream, size will be updated after processing
      };
      
      // Process based on file type and size
      let chunks: string[] | undefined;
      
      if (fileType === FileType.TEXT && typeof data === 'string' && data.length <= this.MAX_DIRECT_PROCESSING_SIZE) {
        // For small text files, process directly
        chunks = this.chunkText(data);
        metadata.extractedText = data;
      } else if (fileType === FileType.PDF) {
        // For PDFs, extract text (simplified implementation)
        // In a real implementation, this would use a PDF parsing library
        metadata.additionalMetadata = { needsExtraction: true };
      } else if (fileType === FileType.IMAGE) {
        // For images, extract metadata (simplified implementation)
        // In a real implementation, this would extract image metadata
        metadata.additionalMetadata = { needsOCR: true };
      }
      
      return {
        r2Key,
        metadata,
        chunks
      };
    } catch (error) {
      console.error('Error processing file:', error);
      throw new ServiceError('Failed to process file', {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { contentType, fileName }
      });
    }
  }
  
  /**
   * Extract text from a PDF file
   * @param env Environment bindings
   * @param r2Key R2 object key
   * @returns Promise with extracted text
   */
  async extractTextFromPdf(env: Bindings, r2Key: string): Promise<string> {
    try {
      // Download the PDF from R2
      const object = await r2Service.downloadObject(env, r2Key);
      
      if (!object) {
        throw new Error(`PDF with key ${r2Key} not found`);
      }
      
      // In a real implementation, this would use a PDF parsing library
      // For now, we'll return a placeholder
      return `[PDF Text Extraction Placeholder for ${r2Key}]`;
    } catch (error) {
      console.error(`Error extracting text from PDF ${r2Key}:`, error);
      throw new ServiceError(`Failed to extract text from PDF ${r2Key}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { r2Key }
      });
    }
  }
  
  /**
   * Extract text from an image using OCR
   * @param env Environment bindings
   * @param r2Key R2 object key
   * @returns Promise with extracted text
   */
  async extractTextFromImage(env: Bindings, r2Key: string): Promise<string> {
    try {
      // Download the image from R2
      const object = await r2Service.downloadObject(env, r2Key);
      
      if (!object) {
        throw new Error(`Image with key ${r2Key} not found`);
      }
      
      // In a real implementation, this would use OCR via Workers AI
      // For now, we'll return a placeholder
      return `[Image OCR Placeholder for ${r2Key}]`;
    } catch (error) {
      console.error(`Error extracting text from image ${r2Key}:`, error);
      throw new ServiceError(`Failed to extract text from image ${r2Key}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { r2Key }
      });
    }
  }
  
  /**
   * Chunk text into smaller pieces for processing
   * @param text Text to chunk
   * @returns Array of text chunks
   */
  chunkText(text: string): string[] {
    const chunks: string[] = [];
    
    // Simple chunking by size
    for (let i = 0; i < text.length; i += this.MAX_CHUNK_SIZE) {
      chunks.push(text.substring(i, i + this.MAX_CHUNK_SIZE));
    }
    
    return chunks;
  }
  
  /**
   * Get file extension from content type or file name
   * @param contentType Content type
   * @param fileName Optional file name
   * @returns File extension with dot
   */
  private getFileExtension(contentType: string, fileName?: string): string {
    // Try to get extension from file name first
    if (fileName) {
      const lastDotIndex = fileName.lastIndexOf('.');
      if (lastDotIndex !== -1) {
        return fileName.substring(lastDotIndex);
      }
    }
    
    // Get extension from content type
    const normalizedContentType = contentType.toLowerCase();
    
    switch (normalizedContentType) {
      case 'text/plain':
        return '.txt';
      case 'text/html':
        return '.html';
      case 'text/css':
        return '.css';
      case 'text/javascript':
      case 'application/javascript':
        return '.js';
      case 'application/json':
        return '.json';
      case 'application/xml':
      case 'text/xml':
        return '.xml';
      case 'application/pdf':
        return '.pdf';
      case 'image/jpeg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/gif':
        return '.gif';
      case 'image/webp':
        return '.webp';
      default:
        return '';
    }
  }
}

// Export singleton instance
export const fileProcessingService = new FileProcessingService();