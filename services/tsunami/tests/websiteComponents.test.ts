import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContentExtractor } from '../src/providers/website/contentExtractor';
import { RobotsChecker } from '../src/providers/website/robotsChecker';
import { WebsiteCrawler } from '../src/providers/website/websiteCrawler';

// Tests for ContentExtractor

describe('ContentExtractor', () => {
  const extractor = new ContentExtractor();

  it('removes comments and scripts', () => {
    const html = `<!--c--><body><script>1</script><div id="content">Hello</div></body>`;
    const result = extractor.extract(html, 'https://example.com');
    expect(result).toContain('Hello');
    expect(result).not.toContain('script');
    expect(result).not.toContain('c--');
  });

  it('extracts main content', () => {
    const html = `<main><h1>Title</h1><p>Message</p></main>`;
    const result = extractor.extract(html, 'https://example.com');
    expect(result).toContain('Title');
    expect(result).toContain('Message');
  });
});

// Tests for RobotsChecker

describe('RobotsChecker', () => {
  const robotsContent = `User-agent: *\nDisallow: /private`; // simple rules
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(robotsContent));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('blocks disallowed paths', async () => {
    const checker = new RobotsChecker('test-agent');
    await checker.initialize('https://example.com');
    expect(checker.isAllowed('https://example.com/public')).toBe(true);
    expect(checker.isAllowed('https://example.com/private/1')).toBe(false);
  });
});

// Tests for WebsiteCrawler

describe.skip('WebsiteCrawler', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (url.toString() === 'https://example.com/') {
        return new Response(
          '<html><body><a href="/internal">in</a><a href="https://ext.com">ex</a></body></html>',
          {
            headers: { 'content-type': 'text/html', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
          },
        );
      }
      if (url.toString() === 'https://example.com/internal') {
        return new Response('<html><body>Internal</body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('Not found', { status: 404 });
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('crawls internal links and records pending external ones', async () => {
    const crawler = new WebsiteCrawler('test-agent');
    crawler.configure({ baseUrl: 'https://example.com', depth: 1, delayMs: 0 });

    const pages = await crawler.crawl(['https://example.com/']);
    const pending = crawler.getPendingUrls();

    expect(pages.length).toBe(2); // root + internal
    expect(pending).toContain('https://ext.com/');
  });
});
