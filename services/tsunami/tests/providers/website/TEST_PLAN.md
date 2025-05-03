# WebsiteProvider Test Plan

This document outlines the comprehensive test plan for the WebsiteProvider implementation in the Tsunami service. The test plan includes unit tests for core components, integration tests, and a mock server setup for consistent testing.

## Test Structure

The tests are organized in the following directory structure:

```
services/tsunami/tests/providers/website/
├── provider.test.ts (existing)
├── robotsChecker.test.ts
├── contentExtractor.test.ts
├── websiteCrawler.test.ts
├── websiteConfigService.test.ts
├── integration.test.ts
├── mockServer.ts
└── TEST_PLAN.md (this document)
```

## Unit Tests for Core Components

### 1. WebsiteProvider Tests (`provider.test.ts`)

The existing provider.test.ts file has been expanded to include:

- **Configuration Handling**: Tests for default configuration values, overriding defaults, and configuration validation.
- **Cursor Management**: Tests for cursor creation, parsing, and handling invalid cursor data.
- **Content Processing**: Tests for HTML and non-HTML content processing, size limit filtering, and metadata header injection.
- **Error Handling**: Tests for crawler errors, extractor errors, and robots.txt errors.

### 2. RobotsChecker Tests (`robotsChecker.test.ts`)

Tests for the RobotsChecker component, which is responsible for parsing and enforcing robots.txt directives:

- **Initialization**: Tests for creating an instance, fetching and parsing robots.txt, handling 404 responses, and handling fetch errors.
- **URL Checking**: Tests for allowing URLs not explicitly disallowed, disallowing URLs matching disallow rules, handling wildcard patterns, and prioritizing specific user agent rules.
- **Robots.txt Parsing**: Tests for handling empty robots.txt, malformed robots.txt, and comments in robots.txt.

### 3. ContentExtractor Tests (`contentExtractor.test.ts`)

Tests for the ContentExtractor component, which is responsible for extracting meaningful content from HTML pages:

- **Content Extraction**: Tests for extracting content from HTML with main tag, article tag, and content class.
- **Element Removal**: Tests for removing script, style, nav, header, footer, ads, sidebars, and social media containers.
- **HTML Processing**: Tests for decoding HTML entities and handling malformed HTML.
- **Error Handling**: Tests for returning original HTML on extraction error.

### 4. WebsiteCrawler Tests (`websiteCrawler.test.ts`)

Tests for the WebsiteCrawler component, which is responsible for crawling websites and fetching pages:

- **Configuration**: Tests for configuring the crawler with default values, overriding defaults, and handling invalid URL patterns.
- **Crawling**: Tests for crawling a single URL, following links up to the specified depth, respecting robots.txt, filtering URLs based on patterns, and handling non-HTML content types.
- **Error Handling**: Tests for handling HTTP errors and network errors gracefully.
- **Pending URLs**: Tests for tracking URLs that were not crawled due to external domain.

### 5. WebsiteConfigService Tests (`websiteConfigService.test.ts`)

Tests for the WebsiteConfigService component, which is responsible for managing website configuration and crawl state:

- **Configuration Management**: Tests for retrieving configuration, returning default configuration, and validating configuration.
- **Crawl State Management**: Tests for retrieving crawl state, saving crawl state, and merging with existing crawl state.
- **Website Patterns**: Tests for returning predefined patterns for common blog platforms.

## Integration Tests

The integration tests (`integration.test.ts`) use a mock server to test the WebsiteProvider's functionality in a more realistic environment:

- **Basic Crawling**: Tests for crawling a simple website, respecting robots.txt directives, and extracting content from different page structures.
- **Incremental Syncing**: Tests for only crawling new or updated pages when using a cursor.
- **Error Handling**: Tests for handling pages with malformed HTML, invalid robots.txt, and rate limiting.
- **Blog Platform Handling**: Tests for extracting content from WordPress-style, Medium-style, and Ghost-style pages.

## Mock Server

The mock server (`mockServer.ts`) provides a consistent environment for testing the WebsiteProvider. It simulates:

- Simple websites with different structures
- Robots.txt handling
- Content extraction from different HTML structures
- Incremental syncing
- Error cases
- Rate limiting
- Different blog platform structures

## Edge Cases Covered

The test plan covers the following edge cases:

- **Malformed HTML**: Tests for handling HTML with unclosed tags, missing elements, and invalid structure.
- **Robots.txt Parsing Failures**: Tests for handling invalid robots.txt files, missing robots.txt files, and malformed directives.
- **Rate Limiting Scenarios**: Tests for handling rate limiting responses and implementing appropriate delays.
- **Content Extraction from Different Blog Formats**: Tests for extracting content from WordPress, Medium, and Ghost blog formats.
- **HTTP Errors**: Tests for handling 404, 500, and other HTTP error responses.
- **Network Errors**: Tests for handling network failures and timeouts.
- **Incremental Syncing**: Tests for handling updated, unchanged, and new content during incremental syncs.

## Running the Tests

To run the tests, use the following command:

```bash
pnpm test -- --dir=services/tsunami/tests/providers/website
```

To run a specific test file:

```bash
pnpm test -- services/tsunami/tests/providers/website/robotsChecker.test.ts
```

## Test-Driven Development Approach

These tests follow the Test-Driven Development (TDD) approach:

1. **Write Failing Tests First**: The tests are written before the implementation, focusing on the expected behavior.
2. **Implement Minimal Code**: The implementation should be minimal, just enough to make the tests pass.
3. **Refactor**: After the tests pass, the code can be refactored to improve design and maintainability.

This approach ensures that the implementation meets the requirements and has good test coverage from the start.