# WebsiteProvider for Tsunami Service

## Overview

The WebsiteProvider is a component of the Tsunami service that enables crawling and ingestion of content from websites. It systematically crawls web pages, extracts meaningful content, and prepares it for storage in the Silo system. This provider is particularly useful for ingesting blog posts, documentation, and other web-based content into your knowledge base.

The WebsiteProvider handles:

- Crawling websites with configurable depth and rate limiting
- Respecting robots.txt directives
- Extracting meaningful content from HTML pages
- Filtering out non-text content and boilerplate elements
- Tracking crawl state for incremental updates
- Injecting metadata headers for proper indexing

## Configuration Options

The WebsiteProvider accepts the following configuration options:

| Option                | Type     | Default    | Description                                                                                                                                          |
| --------------------- | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                 | string   | (required) | The base URL to crawl. This is the starting point for the crawler.                                                                                   |
| `crawlDepth`          | number   | 2          | Maximum depth of links to follow from the base URL. A depth of 0 means only the base URL is crawled, 1 includes direct links from the base URL, etc. |
| `respectRobotsTxt`    | boolean  | true       | Whether to respect robots.txt directives. When enabled, the crawler will check robots.txt rules before crawling pages.                               |
| `delayMs`             | number   | 1000       | Delay between requests in milliseconds. This helps prevent overwhelming the target server.                                                           |
| `includeImages`       | boolean  | false      | Whether to include image files in the crawl results.                                                                                                 |
| `includeScripts`      | boolean  | false      | Whether to include JavaScript files in the crawl results.                                                                                            |
| `includeStyles`       | boolean  | false      | Whether to include CSS files in the crawl results.                                                                                                   |
| `followExternalLinks` | boolean  | false      | Whether to follow links to external domains. When disabled, only links within the same domain as the base URL are crawled.                           |
| `urlPatterns`         | string[] | []         | Array of regex patterns to match URLs to crawl. Only URLs matching at least one pattern will be crawled. If empty, all URLs are considered.          |

## Usage Examples

### Basic Website Ingestion

To register a website for basic ingestion:

```typescript
// Register a website with default settings
const resourceId = JSON.stringify({
  url: 'https://example.com/blog',
});

// Add the resource to Tsunami
await tsunamiClient.addResource({
  resourceId,
  providerType: 'website',
  syncFrequency: 'daily',
});
```

### Advanced Configuration

For more control over the crawling process:

```typescript
// Register a website with advanced configuration
const resourceId = JSON.stringify({
  url: 'https://example.com/docs',
  crawlDepth: 3,
  delayMs: 2000,
  respectRobotsTxt: true,
  includeImages: false,
  includeScripts: false,
  includeStyles: false,
  followExternalLinks: false,
  urlPatterns: ['^https://example\\.com/docs/v2/.*', '^https://example\\.com/docs/tutorials/.*'],
});

// Add the resource to Tsunami
await tsunamiClient.addResource({
  resourceId,
  providerType: 'website',
  syncFrequency: 'weekly',
});
```

### Incremental Updates

The WebsiteProvider maintains state between crawls to support incremental updates:

```typescript
// The provider automatically tracks crawled URLs and pending URLs
// It will only process new or updated content in subsequent crawls
await tsunamiClient.syncResource({
  resourceId: JSON.stringify({ url: 'https://example.com/blog' }),
  providerType: 'website',
});
```

## Best Practices for Different Blog Platforms

### WordPress

WordPress sites typically organize content in a predictable structure:

```typescript
const wordpressConfig = {
  url: 'https://wordpress-example.com',
  urlPatterns: [
    // Focus on post content, avoid admin pages, etc.
    '^https://wordpress-example\\.com/\\d{4}/\\d{2}/.*', // Post permalinks
    '^https://wordpress-example\\.com/category/.*', // Category pages
    '^https://wordpress-example\\.com/tag/.*', // Tag pages
  ],
  crawlDepth: 3,
};
```

### Medium

Medium has a specific structure that can be targeted:

```typescript
const mediumConfig = {
  url: 'https://medium.com/publication-name',
  urlPatterns: [
    // Target article pages, avoid profile pages, etc.
    '^https://medium\\.com/publication-name/[\\w-]+-[a-f0-9]{12}$', // Article pages
  ],
  crawlDepth: 2,
};
```

### Ghost

Ghost blog platforms can be configured as follows:

```typescript
const ghostConfig = {
  url: 'https://ghost-example.com',
  urlPatterns: [
    // Focus on post content
    '^https://ghost-example\\.com/[\\w-]+/$', // Post pages
  ],
  crawlDepth: 2,
};
```

### Documentation Sites

For documentation sites like ReadTheDocs, Docusaurus, or GitBook:

```typescript
const docsConfig = {
  url: 'https://docs-example.com',
  crawlDepth: 4, // Documentation often has deeper hierarchies
  delayMs: 1500,
  urlPatterns: [
    // Focus on documentation pages, avoid search, API, etc.
    '^https://docs-example\\.com/guide/.*',
    '^https://docs-example\\.com/api/.*',
    '^https://docs-example\\.com/tutorials/.*',
  ],
};
```

## Content Extraction

The WebsiteProvider includes a sophisticated content extraction system that:

1. Identifies the main content area of a page by looking for common content containers like `<article>`, `<main>`, or divs with class names like "content" or "post-content"
2. Removes boilerplate elements like navigation, headers, footers, sidebars, and advertisements
3. Cleans up HTML and converts it to plain text while preserving important formatting
4. Handles HTML entities and special characters

This extraction process helps ensure that only the meaningful content is stored, reducing noise and improving the quality of the ingested data.

## Limitations and Considerations

### Technical Limitations

- **Maximum Content Size**: Files larger than 2MB will be skipped
- **Rate Limiting**: Default delay between requests is 1 second
- **Depth Limitation**: Default maximum crawl depth is 2 levels
- **Content Types**: By default, only text-based content (HTML, plain text, JSON, JavaScript, CSS) is processed
- **JavaScript Rendering**: The crawler does not execute JavaScript, so content rendered by JavaScript may not be captured

### Legal and Ethical Considerations

When using the WebsiteProvider, be mindful of the following:

1. **Respect robots.txt**: The provider respects robots.txt by default, but this can be disabled. It's recommended to keep this enabled to respect website owners' wishes.

2. **Rate Limiting**: Use appropriate delays between requests to avoid overwhelming target servers. Consider increasing the `delayMs` value for smaller sites.

3. **Terms of Service**: Ensure you're not violating the terms of service of the websites you're crawling.

4. **Copyright**: Be aware that crawling and storing content may have copyright implications. Ensure you have the right to use the content you're ingesting.

5. **Privacy**: Be careful when crawling sites that may contain personal information.

### Best Practices

- Start with a small `crawlDepth` and gradually increase if needed
- Use specific `urlPatterns` to focus crawling on relevant content
- Set appropriate `delayMs` values based on the target site's size and capacity
- Regularly review and update your crawling configuration as websites change
- Consider reaching out to website owners for permission or to establish formal data sharing arrangements
- Monitor your crawls to ensure they're not causing issues for the target sites

## Implementation Details

The WebsiteProvider is composed of several specialized components:

1. **WebsiteCrawler**: Handles the actual crawling process, following links and respecting configuration options
2. **RobotsChecker**: Parses and enforces robots.txt directives
3. **ContentExtractor**: Extracts and cleans meaningful content from HTML pages
4. **Cursor Management**: Tracks crawled URLs and maintains state between crawls

These components work together to provide a robust and respectful web crawling solution that can be tailored to various use cases.
