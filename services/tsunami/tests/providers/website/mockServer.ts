/**
 * Mock Server for WebsiteProvider Integration Tests
 * 
 * This file sets up a mock HTTP server that simulates different website scenarios
 * for testing the WebsiteProvider. It provides endpoints for:
 * - Simple websites with different structures
 * - Robots.txt handling
 * - Content extraction from different HTML structures
 * - Incremental syncing
 * - Error cases
 * - Different blog platform structures
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { getLogger } from '@dome/common';

const logger = getLogger();
const PORT = 9876;
let server: Server | null = null;

// Track if pages have been "updated" for incremental sync testing
let pagesUpdated = false;

/**
 * Start the mock server
 */
export async function startMockServer(): Promise<void> {
  if (server) {
    return;
  }

  server = createServer(handleRequest);
  
  return new Promise((resolve) => {
    server!.listen(PORT, () => {
      logger.info({ port: PORT }, 'Mock server started');
      resolve();
    });
  });
}

/**
 * Stop the mock server
 */
export async function stopMockServer(): Promise<void> {
  if (!server) {
    return;
  }

  return new Promise((resolve, reject) => {
    server!.close((err) => {
      if (err) {
        reject(err);
      } else {
        server = null;
        logger.info('Mock server stopped');
        resolve();
      }
    });
  });
}

/**
 * Get the URL of the mock server
 */
export function getMockServerUrl(): string {
  return `http://localhost:${PORT}`;
}

/**
 * Handle incoming requests to the mock server
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;
  
  // Check for update parameter to simulate page updates
  if (url.searchParams.has('update')) {
    pagesUpdated = url.searchParams.get('update') === 'true';
  }
  
  // Handle different paths
  try {
    if (path === '/robots.txt') {
      handleRobotsTxt(req, res);
    } else if (path.startsWith('/simple-site')) {
      handleSimpleSite(req, res, path);
    } else if (path.startsWith('/with-robots')) {
      handleWithRobots(req, res, path);
    } else if (path.startsWith('/content-extraction')) {
      handleContentExtraction(req, res, path);
    } else if (path.startsWith('/incremental')) {
      handleIncremental(req, res, path);
    } else if (path.startsWith('/error-cases')) {
      handleErrorCases(req, res, path);
    } else if (path.startsWith('/rate-limited')) {
      handleRateLimited(req, res, path);
    } else if (path.startsWith('/blog-platforms')) {
      handleBlogPlatforms(req, res, path);
    } else {
      // Default response for unknown paths
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  } catch (error) {
    logger.error({ path, error }, 'Error handling request');
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

/**
 * Handle robots.txt requests
 */
function handleRobotsTxt(req: IncomingMessage, res: ServerResponse): void {
  const host = req.headers.host || '';
  
  if (host.includes('invalid-robots')) {
    // Invalid robots.txt
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('This is not a valid robots.txt file');
  } else if (host.includes('with-robots') || req.url?.includes('/with-robots')) {
    // Valid robots.txt with disallow rules
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`
      User-agent: *
      Disallow: /with-robots/admin
      Allow: /with-robots/public
    `);
  } else {
    // Default robots.txt
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`
      User-agent: *
      Allow: /
    `);
  }
}

/**
 * Handle simple site requests
 */
function handleSimpleSite(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (path === '/simple-site' || path === '/simple-site/') {
    // Home page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Simple Site</title></head>
        <body>
          <h1>Simple Site Home Page</h1>
          <p>This is a simple site for testing the WebsiteProvider.</p>
          <ul>
            <li><a href="/simple-site/about">About</a></li>
            <li><a href="/simple-site/contact">Contact</a></li>
          </ul>
        </body>
      </html>
    `);
  } else if (path === '/simple-site/about') {
    // About page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>About - Simple Site</title></head>
        <body>
          <h1>About Page</h1>
          <p>This is the about page.</p>
          <a href="/simple-site">Back to Home</a>
        </body>
      </html>
    `);
  } else if (path === '/simple-site/contact') {
    // Contact page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Contact - Simple Site</title></head>
        <body>
          <h1>Contact Page</h1>
          <p>This is the contact page.</p>
          <a href="/simple-site">Back to Home</a>
        </body>
      </html>
    `);
  } else {
    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

/**
 * Handle site with robots.txt directives
 */
function handleWithRobots(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (path === '/with-robots' || path === '/with-robots/') {
    // Home page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Site with Robots.txt</title></head>
        <body>
          <h1>Site with Robots.txt</h1>
          <p>This site has robots.txt directives.</p>
          <ul>
            <li><a href="/with-robots/public">Public Page (Allowed)</a></li>
            <li><a href="/with-robots/admin">Admin Page (Disallowed)</a></li>
          </ul>
        </body>
      </html>
    `);
  } else if (path === '/with-robots/public') {
    // Public page (allowed by robots.txt)
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Public Page</title></head>
        <body>
          <h1>Public Page</h1>
          <p>This page is allowed by robots.txt.</p>
          <a href="/with-robots">Back to Home</a>
        </body>
      </html>
    `);
  } else if (path === '/with-robots/admin') {
    // Admin page (disallowed by robots.txt)
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Admin Page</title></head>
        <body>
          <h1>Admin Page</h1>
          <p>This page is disallowed by robots.txt.</p>
          <a href="/with-robots">Back to Home</a>
        </body>
      </html>
    `);
  } else {
    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

/**
 * Handle content extraction test cases
 */
function handleContentExtraction(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (path === '/content-extraction' || path === '/content-extraction/') {
    // Home page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Content Extraction Tests</title></head>
        <body>
          <h1>Content Extraction Tests</h1>
          <p>This site has different HTML structures for testing content extraction.</p>
          <ul>
            <li><a href="/content-extraction/main-tag">Page with Main Tag</a></li>
            <li><a href="/content-extraction/article-tag">Page with Article Tag</a></li>
            <li><a href="/content-extraction/content-class">Page with Content Class</a></li>
          </ul>
        </body>
      </html>
    `);
  } else if (path === '/content-extraction/main-tag') {
    // Page with main tag
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Page with Main Tag</title></head>
        <body>
          <header>
            <h1>Header Content</h1>
            <nav>Navigation Links</nav>
          </header>
          <main>
            <h1>Main Tag Content</h1>
            <p>This content is inside a main tag and should be extracted.</p>
            <p>The header and footer should be removed.</p>
          </main>
          <footer>
            <p>Footer Content</p>
          </footer>
        </body>
      </html>
    `);
  } else if (path === '/content-extraction/article-tag') {
    // Page with article tag
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Page with Article Tag</title></head>
        <body>
          <header>
            <h1>Header Content</h1>
            <nav>Navigation Content</nav>
          </header>
          <article>
            <h1>Article Tag Content</h1>
            <p>This content is inside an article tag and should be extracted.</p>
            <p>The header and navigation should be removed.</p>
          </article>
          <aside>
            <p>Sidebar Content</p>
          </aside>
        </body>
      </html>
    `);
  } else if (path === '/content-extraction/content-class') {
    // Page with content class
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Page with Content Class</title></head>
        <body>
          <header>
            <h1>Header Content</h1>
          </header>
          <div class="sidebar">
            <p>Sidebar Content</p>
          </div>
          <div class="content">
            <h1>Content Class Content</h1>
            <p>This content is inside a div with class="content" and should be extracted.</p>
            <p>The header and sidebar should be removed.</p>
          </div>
          <div class="ads">
            <p>Advertisement Content</p>
          </div>
        </body>
      </html>
    `);
  } else {
    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

/**
 * Handle incremental sync test cases
 */
function handleIncremental(req: IncomingMessage, res: ServerResponse, path: string): void {
  const lastModified = pagesUpdated 
    ? new Date().toUTCString() 
    : new Date('2025-01-01').toUTCString();
  
  if (path === '/incremental' || path === '/incremental/') {
    // Home page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': lastModified
    });
    res.end(`
      <html>
        <head><title>Incremental Sync Tests</title></head>
        <body>
          <h1>Incremental Sync Tests</h1>
          <p>This site is for testing incremental syncing.</p>
          <ul>
            <li><a href="/incremental/page1">Page 1</a></li>
            <li><a href="/incremental/page2">Page 2</a></li>
            <li><a href="/incremental/updated-page">Updated Page</a></li>
          </ul>
        </body>
      </html>
    `);
  } else if (path === '/incremental/page1') {
    // Page 1 (never updated)
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date('2025-01-01').toUTCString()
    });
    res.end(`
      <html>
        <head><title>Page 1</title></head>
        <body>
          <h1>Page 1</h1>
          <p>This page never changes.</p>
          <a href="/incremental">Back to Home</a>
        </body>
      </html>
    `);
  } else if (path === '/incremental/page2') {
    // Page 2 (never updated)
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date('2025-01-01').toUTCString()
    });
    res.end(`
      <html>
        <head><title>Page 2</title></head>
        <body>
          <h1>Page 2</h1>
          <p>This page never changes.</p>
          <a href="/incremental">Back to Home</a>
        </body>
      </html>
    `);
  } else if (path === '/incremental/updated-page') {
    // Updated page (changes when pagesUpdated is true)
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': lastModified
    });
    res.end(`
      <html>
        <head><title>Updated Page</title></head>
        <body>
          <h1>Updated Page</h1>
          <p>This page ${pagesUpdated ? 'has been updated' : 'will be updated'}.</p>
          <a href="/incremental">Back to Home</a>
        </body>
      </html>
    `);
  } else {
    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

/**
 * Handle error test cases
 */
function handleErrorCases(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (path === '/error-cases' || path === '/error-cases/') {
    // Home page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Error Test Cases</title></head>
        <body>
          <h1>Error Test Cases</h1>
          <p>This site has various error cases for testing.</p>
          <ul>
            <li><a href="/error-cases/malformed-html">Malformed HTML</a></li>
            <li><a href="/error-cases/invalid-robots">Invalid Robots.txt</a></li>
          </ul>
        </body>
      </html>
    `);
  } else if (path === '/error-cases/malformed-html') {
    // Malformed HTML page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Malformed HTML</title>
        <body>
          <h1>Malformed HTML Page
          <p>This page has malformed HTML with unclosed tags.
          <div>This div is not closed.
          <p>Another unclosed paragraph.
        </body>
      </html>
    `);
  } else if (path === '/error-cases/invalid-robots') {
    // Page with invalid robots.txt
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Invalid Robots.txt</title></head>
        <body>
          <h1>Invalid Robots.txt</h1>
          <p>This site has an invalid robots.txt file.</p>
        </body>
      </html>
    `);
  } else {
    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

/**
 * Handle rate limiting test cases
 */
// Track request count to simulate rate limiting
let rateLimitRequestCount = 0;

function handleRateLimited(req: IncomingMessage, res: ServerResponse, path: string): void {
  rateLimitRequestCount++;
  
  if (rateLimitRequestCount > 10 && rateLimitRequestCount % 3 === 0) {
    // Simulate rate limiting for every third request after 10 requests
    res.writeHead(429, { 
      'Content-Type': 'text/plain',
      'Retry-After': '1'
    });
    res.end('Too Many Requests');
    return;
  }
  
  if (path === '/rate-limited' || path === '/rate-limited/') {
    // Home page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Rate Limited Site</title></head>
        <body>
          <h1>Rate Limited Site</h1>
          <p>This site simulates rate limiting.</p>
          <ul>
            <li><a href="/rate-limited/page1">Page 1</a></li>
            <li><a href="/rate-limited/page2">Page 2</a></li>
            <li><a href="/rate-limited/page3">Page 3</a></li>
          </ul>
        </body>
      </html>
    `);
  } else if (path.startsWith('/rate-limited/page')) {
    // Generic page
    const pageNumber = path.split('/').pop()?.replace('page', '') || '0';
    
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Page ${pageNumber}</title></head>
        <body>
          <h1>Page ${pageNumber}</h1>
          <p>This is page ${pageNumber} of the rate limited site.</p>
          <a href="/rate-limited">Back to Home</a>
        </body>
      </html>
    `);
  } else {
    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

/**
 * Handle blog platform test cases
 */
function handleBlogPlatforms(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (path === '/blog-platforms' || path === '/blog-platforms/') {
    // Home page
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Blog Platform Tests</title></head>
        <body>
          <h1>Blog Platform Tests</h1>
          <p>This site simulates different blog platforms.</p>
          <ul>
            <li><a href="/blog-platforms/wordpress">WordPress</a></li>
            <li><a href="/blog-platforms/medium">Medium</a></li>
            <li><a href="/blog-platforms/ghost">Ghost</a></li>
          </ul>
        </body>
      </html>
    `);
  } else if (path === '/blog-platforms/wordpress' || path === '/blog-platforms/wordpress/') {
    // WordPress home
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>WordPress Blog</title></head>
        <body>
          <header>
            <h1>WordPress Blog</h1>
            <nav>
              <ul>
                <li><a href="/blog-platforms/wordpress/2025/01/sample-post">Sample Post</a></li>
                <li><a href="/blog-platforms/wordpress/category/news">News Category</a></li>
              </ul>
            </nav>
          </header>
          <main>
            <article>
              <h2><a href="/blog-platforms/wordpress/2025/01/sample-post">Sample Post</a></h2>
              <p>Excerpt of the sample post...</p>
            </article>
          </main>
          <footer>
            <p>WordPress Footer</p>
          </footer>
        </body>
      </html>
    `);
  } else if (path === '/blog-platforms/wordpress/2025/01/sample-post') {
    // WordPress post
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Sample Post - WordPress Blog</title></head>
        <body>
          <header>
            <h1>WordPress Blog</h1>
            <nav>
              <ul>
                <li><a href="/blog-platforms/wordpress">Home</a></li>
                <li><a href="/blog-platforms/wordpress/category/news">News Category</a></li>
              </ul>
            </nav>
          </header>
          <main>
            <article class="post">
              <h1>Sample Post</h1>
              <div class="post-meta">
                <span class="date">January 1, 2025</span>
                <span class="author">By Admin</span>
              </div>
              <div class="post-content">
                <p>WordPress Post Content</p>
                <p>This is a sample WordPress post.</p>
              </div>
            </article>
          </main>
          <footer>
            <p>WordPress Footer</p>
          </footer>
        </body>
      </html>
    `);
  } else if (path === '/blog-platforms/wordpress/category/news') {
    // WordPress category
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>News Category - WordPress Blog</title></head>
        <body>
          <header>
            <h1>WordPress Blog</h1>
            <nav>
              <ul>
                <li><a href="/blog-platforms/wordpress">Home</a></li>
              </ul>
            </nav>
          </header>
          <main>
            <h1>Category: News</h1>
            <article>
              <h2><a href="/blog-platforms/wordpress/2025/01/sample-post">Sample Post</a></h2>
              <p>Excerpt of the sample post...</p>
            </article>
          </main>
          <footer>
            <p>WordPress Footer</p>
          </footer>
        </body>
      </html>
    `);
  } else if (path === '/blog-platforms/medium' || path === '/blog-platforms/medium/') {
    // Medium home
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Medium Blog</title></head>
        <body>
          <header>
            <h1>Medium Blog</h1>
          </header>
          <main>
            <article>
              <h2><a href="/blog-platforms/medium/sample-post-123456789abc">Sample Post</a></h2>
              <p>Excerpt of the sample post...</p>
            </article>
          </main>
        </body>
      </html>
    `);
  } else if (path === '/blog-platforms/medium/sample-post-123456789abc') {
    // Medium post
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Sample Post - Medium Blog</title></head>
        <body>
          <header>
            <h1>Medium Blog</h1>
          </header>
          <article>
            <h1>Sample Post</h1>
            <div class="author">
              <img src="/avatar.jpg" alt="Author Avatar">
              <span>Author Name</span>
            </div>
            <div class="content">
              <p>Medium Post Content</p>
              <p>This is a sample Medium post.</p>
            </div>
          </article>
        </body>
      </html>
    `);
  } else if (path === '/blog-platforms/ghost' || path === '/blog-platforms/ghost/') {
    // Ghost home
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Ghost Blog</title></head>
        <body>
          <header>
            <h1>Ghost Blog</h1>
          </header>
          <main>
            <article>
              <h2><a href="/blog-platforms/ghost/sample-post/">Sample Post</a></h2>
              <p>Excerpt of the sample post...</p>
            </article>
          </main>
        </body>
      </html>
    `);
  } else if (path === '/blog-platforms/ghost/sample-post/') {
    // Ghost post
    res.writeHead(200, { 
      'Content-Type': 'text/html',
      'Last-Modified': new Date().toUTCString()
    });
    res.end(`
      <html>
        <head><title>Sample Post - Ghost Blog</title></head>
        <body>
          <header>
            <h1>Ghost Blog</h1>
          </header>
          <article class="post">
            <h1>Sample Post</h1>
            <div class="post-content">
              <p>Ghost Post Content</p>
              <p>This is a sample Ghost post.</p>
            </div>
          </article>
        </body>
      </html>
    `);
  } else {
    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}
