// Jest is automatically available in the global scope
import { fileProcessingService, FileType } from '../../src/services/fileProcessingService';
import { r2Service } from '../../src/services/r2Service';
import { ServiceError } from '@dome/common';

// Mock dependencies
jest.mock('../../src/services/r2Service');

describe('FileProcessingService', () => {
  // Mock environment
  const mockEnv = {
    RAW: {} as R2Bucket,
    D1_DATABASE: {} as D1Database,
    VECTORIZE: {} as VectorizeIndex,
    EVENTS: {} as Queue<any>,
    EMBED_QUEUE: {} as Queue<any>,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('detectFileType', () => {
    it('should detect text file types', () => {
      expect(fileProcessingService.detectFileType('text/plain')).toBe(FileType.TEXT);
      expect(fileProcessingService.detectFileType('text/html')).toBe(FileType.TEXT);
      expect(fileProcessingService.detectFileType('application/json')).toBe(FileType.TEXT);
      expect(fileProcessingService.detectFileType('application/xml')).toBe(FileType.TEXT);
    });

    it('should detect PDF file type', () => {
      expect(fileProcessingService.detectFileType('application/pdf')).toBe(FileType.PDF);
    });

    it('should detect image file types', () => {
      expect(fileProcessingService.detectFileType('image/jpeg')).toBe(FileType.IMAGE);
      expect(fileProcessingService.detectFileType('image/png')).toBe(FileType.IMAGE);
      expect(fileProcessingService.detectFileType('image/gif')).toBe(FileType.IMAGE);
    });

    it('should return UNKNOWN for unsupported file types', () => {
      expect(fileProcessingService.detectFileType('application/octet-stream')).toBe(
        FileType.UNKNOWN,
      );
      expect(fileProcessingService.detectFileType('audio/mpeg')).toBe(FileType.UNKNOWN);
    });
  });

  describe('processFile', () => {
    it('should process a text file', async () => {
      // Mock R2 upload
      (r2Service.uploadObject as jest.Mock).mockResolvedValue({
        contentType: 'text/plain',
        size: 100,
        etag: 'test-etag',
        uploaded: new Date(),
      });

      // Call the service
      const result = await fileProcessingService.processFile(
        mockEnv,
        'This is a test text file',
        'text/plain',
        'test.txt',
      );

      // Verify the result
      expect(result.metadata.fileType).toBe(FileType.TEXT);
      expect(result.metadata.contentType).toBe('text/plain');
      expect(result.metadata.extractedText).toBe('This is a test text file');
      expect(result.chunks).toBeDefined();
      expect(result.chunks?.length).toBeGreaterThan(0);

      // Verify R2 service was called
      expect(r2Service.uploadObject).toHaveBeenCalledWith(
        mockEnv,
        expect.stringContaining('files/'),
        'This is a test text file',
        'text/plain',
      );
    });

    it('should process a PDF file', async () => {
      // Mock R2 upload
      (r2Service.uploadObject as jest.Mock).mockResolvedValue({
        contentType: 'application/pdf',
        size: 1000,
        etag: 'test-etag',
        uploaded: new Date(),
      });

      // Create a mock PDF buffer
      const pdfBuffer = new ArrayBuffer(1000);

      // Call the service
      const result = await fileProcessingService.processFile(
        mockEnv,
        pdfBuffer,
        'application/pdf',
        'test.pdf',
      );

      // Verify the result
      expect(result.metadata.fileType).toBe(FileType.PDF);
      expect(result.metadata.contentType).toBe('application/pdf');
      expect(result.metadata.additionalMetadata).toEqual({ needsExtraction: true });
      expect(result.chunks).toBeUndefined();

      // Verify R2 service was called
      expect(r2Service.uploadObject).toHaveBeenCalledWith(
        mockEnv,
        expect.stringContaining('files/'),
        pdfBuffer,
        'application/pdf',
      );
    });

    it('should process an image file', async () => {
      // Mock R2 upload
      (r2Service.uploadObject as jest.Mock).mockResolvedValue({
        contentType: 'image/jpeg',
        size: 500,
        etag: 'test-etag',
        uploaded: new Date(),
      });

      // Create a mock image buffer
      const imageBuffer = new ArrayBuffer(500);

      // Call the service
      const result = await fileProcessingService.processFile(
        mockEnv,
        imageBuffer,
        'image/jpeg',
        'test.jpg',
      );

      // Verify the result
      expect(result.metadata.fileType).toBe(FileType.IMAGE);
      expect(result.metadata.contentType).toBe('image/jpeg');
      expect(result.metadata.additionalMetadata).toEqual({ needsOCR: true });
      expect(result.chunks).toBeUndefined();

      // Verify R2 service was called
      expect(r2Service.uploadObject).toHaveBeenCalledWith(
        mockEnv,
        expect.stringContaining('files/'),
        imageBuffer,
        'image/jpeg',
      );
    });

    it('should throw ServiceError when upload fails', async () => {
      // Mock R2 upload to fail
      (r2Service.uploadObject as jest.Mock).mockRejectedValue(new Error('Upload failed'));

      // Call the service and expect it to throw
      await expect(
        fileProcessingService.processFile(mockEnv, 'test data', 'text/plain', 'test.txt'),
      ).rejects.toThrow(ServiceError);
    });
  });

  describe('extractTextFromPdf', () => {
    it('should extract text from a PDF', async () => {
      // Mock R2 download
      (r2Service.downloadObject as jest.Mock).mockResolvedValue({
        data: new ReadableStream(),
        metadata: {
          contentType: 'application/pdf',
          size: 1000,
          etag: 'test-etag',
          uploaded: new Date(),
        },
      });

      // Call the service
      const result = await fileProcessingService.extractTextFromPdf(mockEnv, 'test-key');

      // Verify the result
      expect(result).toContain('[PDF Text Extraction Placeholder');
      expect(result).toContain('test-key');

      // Verify R2 service was called
      expect(r2Service.downloadObject).toHaveBeenCalledWith(mockEnv, 'test-key');
    });

    it('should throw error when PDF is not found', async () => {
      // Mock R2 download to return null
      (r2Service.downloadObject as jest.Mock).mockResolvedValue(null);

      // Call the service and expect it to throw
      await expect(fileProcessingService.extractTextFromPdf(mockEnv, 'test-key')).rejects.toThrow(
        'PDF with key test-key not found',
      );
    });

    it('should throw ServiceError when download fails', async () => {
      // Mock R2 download to fail
      (r2Service.downloadObject as jest.Mock).mockRejectedValue(new Error('Download failed'));

      // Call the service and expect it to throw
      await expect(fileProcessingService.extractTextFromPdf(mockEnv, 'test-key')).rejects.toThrow(
        ServiceError,
      );
    });
  });

  describe('extractTextFromImage', () => {
    it('should extract text from an image', async () => {
      // Mock R2 download
      (r2Service.downloadObject as jest.Mock).mockResolvedValue({
        data: new ReadableStream(),
        metadata: {
          contentType: 'image/jpeg',
          size: 500,
          etag: 'test-etag',
          uploaded: new Date(),
        },
      });

      // Call the service
      const result = await fileProcessingService.extractTextFromImage(mockEnv, 'test-key');

      // Verify the result
      expect(result).toContain('[Image OCR Placeholder');
      expect(result).toContain('test-key');

      // Verify R2 service was called
      expect(r2Service.downloadObject).toHaveBeenCalledWith(mockEnv, 'test-key');
    });

    it('should throw error when image is not found', async () => {
      // Mock R2 download to return null
      (r2Service.downloadObject as jest.Mock).mockResolvedValue(null);

      // Call the service and expect it to throw
      await expect(fileProcessingService.extractTextFromImage(mockEnv, 'test-key')).rejects.toThrow(
        'Image with key test-key not found',
      );
    });

    it('should throw ServiceError when download fails', async () => {
      // Mock R2 download to fail
      (r2Service.downloadObject as jest.Mock).mockRejectedValue(new Error('Download failed'));

      // Call the service and expect it to throw
      await expect(fileProcessingService.extractTextFromImage(mockEnv, 'test-key')).rejects.toThrow(
        ServiceError,
      );
    });
  });

  describe('chunkText', () => {
    it('should chunk text into smaller pieces', () => {
      // Create a long text
      const longText = 'a'.repeat(10000);

      // Call the service
      const chunks = fileProcessingService.chunkText(longText);

      // Verify the result
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].length).toBeLessThanOrEqual(4096); // MAX_CHUNK_SIZE
      expect(chunks.join('')).toEqual(longText);
    });

    it('should return a single chunk for short text', () => {
      // Create a short text
      const shortText = 'This is a short text';

      // Call the service
      const chunks = fileProcessingService.chunkText(shortText);

      // Verify the result
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toEqual(shortText);
    });
  });
});
