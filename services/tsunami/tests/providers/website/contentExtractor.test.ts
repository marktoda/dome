import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentExtractor } from '../../../src/providers/website/contentExtractor';

// Mock logger
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('ContentExtractor', () => {
  let extractor: ContentExtractor;

  beforeEach(() => {
    extractor = new ContentExtractor();
    vi.clearAllMocks();
  });

  describe('extract', () => {
    it('should extract content from HTML with main tag', () => {
      const html = `
        <html>
          <head><title>Test Page</title></head>
          <body>
            <header>Header content</header>
            <main>
              <h1>Main Content</h1>
              <p>This is the main content.</p>
            </main>
            <footer>Footer content</footer>
          </body>
        </html>
      `;
      
      const result = extractor.extract(html, 'https://example.com');
      
      expect(result).toContain('Main Content');
      expect(result).toContain('This is the main content.');
      expect(result).not.toContain('Header content');
      expect(result).not.toContain('Footer content');
    });

    it('should extract content from HTML with article tag', () => {
      const html = `
        <html>
          <head><title>Test Page</title></head>
          <body>
            <header>Header content</header>
            <article>
              <h1>Article Content</h1>
              <p>This is the article content.</p>
            </article>
            <footer>Footer content</footer>
          </body>
        </html>
      `;
      
      const result = extractor.extract(html, 'https://example.com');
      
      expect(result).toContain('Article Content');
      expect(result).toContain('This is the article content.');
      expect(result).not.toContain('Header content');
      expect(result).not.toContain('Footer content');
    });

    it('should extract content from HTML with content class', () => {
      const html = `
        <html>
          <head><title>Test Page</title></head>
          <body>
            <header>Header content</header>
            <div class="content">
              <h1>Content Div</h1>
              <p>This is the content div.</p>
            </div>
            <footer>Footer content</footer>
          </body>
        </html>
      `;
      
      const result = extractor.extract(html, 'https://example.com');
      
      expect(result).toContain('Content Div');
      expect(result).toContain('This is the content div.');
      expect(result).not.toContain('Header content');
      expect(result).not.toContain('Footer content');
    });

    it('should fallback to body when no content containers are found', () => {
      const html = `
        <html>
          <head><title>Test Page</title></head>
          <body>
            <h1>Body Content</h1>
            <p>This is the body content.</p>
          </body>
        </html>
      `;
      
      const result = extractor.extract(html, 'https://example.com');
      
      expect(result).toContain('Body Content');
      expect(result).toContain('This is the body content.');
    });

    it('should remove script, style, nav, header, and footer elements', () => {
      const html = `
        <html>
          <head>
            <title>Test Page</title>
            <style>body { color: red; }</style>
            <script>console.log('test');</script>
          </head>
          <body>
            <header>Header content</header>
            <nav>Navigation content</nav>
            <div class="content">
              <h1>Content</h1>
              <p>This is the content.</p>
              <script>alert('inline');</script>
            </div>
            <footer>Footer content</footer>
          </body>
        </html>
      `;
      
      const result = extractor.extract(html, 'https://example.com');
      
      expect(result).toContain('Content');
      expect(result).toContain('This is the content.');
      expect(result).not.toContain('console.log');
      expect(result).not.toContain('alert');
      expect(result).not.toContain('color: red');
      expect(result).not.toContain('Header content');
      expect(result).not.toContain('Navigation content');
      expect(result).not.toContain('Footer content');
    });

    it('should remove ads, sidebars, and social media containers', () => {
      const html = `
        <html>
          <body>
            <div class="content">
              <h1>Content</h1>
              <p>This is the content.</p>
              <div class="ads">Advertisement</div>
              <div class="sidebar">Sidebar content</div>
              <div class="social">Social media links</div>
            </div>
          </body>
        </html>
      `;
      
      const result = extractor.extract(html, 'https://example.com');
      
      expect(result).toContain('Content');
      expect(result).toContain('This is the content.');
      expect(result).not.toContain('Advertisement');
      expect(result).not.toContain('Sidebar content');
      expect(result).not.toContain('Social media links');
    });

    it('should decode HTML entities', () => {
      const html = `
        <div>
          <p>This &amp; that</p>
          <p>Less than &lt; greater than &gt;</p>
          <p>Quote &quot;test&quot; and apostrophe&#39;s</p>
          <p>Copyright &copy; 2025</p>
        </div>
      `;
      
      const result = extractor.extract(html, 'https://example.com');
      
      expect(result).toContain('This & that');
      expect(result).toContain('Less than < greater than >');
      expect(result).toContain('Quote "test" and apostrophe\'s');
      expect(result).toContain('Copyright © 2025');
    });

    it('should handle malformed HTML gracefully', () => {
      const malformedHtml = `
        <html>
          <body>
            <div class="content">
              <h1>Malformed HTML
              <p>Missing closing tags
              <div>Nested unclosed div
          </body>
        </html>
      `;
      
      const result = extractor.extract(malformedHtml, 'https://example.com');
      
      // Should still extract something meaningful
      expect(result).toContain('Malformed HTML');
      expect(result).toContain('Missing closing tags');
    });

    it('should return original HTML on extraction error', () => {
      // Create a spy that throws an error
      const extractSpy = vi.spyOn(extractor as any, 'extractMainContent');
      extractSpy.mockImplementationOnce(() => {
        throw new Error('Extraction error');
      });
      
      const html = '<html><body><p>Original content</p></body></html>';
      
      const result = extractor.extract(html, 'https://example.com');
      
      expect(result).toBe(html);
      
      // Restore the original implementation
      extractSpy.mockRestore();
    });
  });
});
