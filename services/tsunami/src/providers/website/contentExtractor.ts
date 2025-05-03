/**
 * ContentExtractor
 * 
 * This class is responsible for extracting meaningful content from HTML pages
 * by removing boilerplate content, navigation, headers, footers, etc.
 */
import { getLogger } from '@dome/common';

export class ContentExtractor {
  private log = getLogger();
  
  /**
   * Extract meaningful content from an HTML page
   * @param html The HTML content to extract from
   * @param url The URL of the page (for logging)
   * @returns The extracted content
   */
  extract(html: string, url: string): string {
    try {
      // Remove comments first
      let content = this.removeComments(html);
      
      // Extract the main content
      content = this.extractMainContent(content);
      
      // Clean up the content
      content = this.cleanContent(content);
      
      this.log.debug({ 
        url, 
        originalSize: html.length, 
        extractedSize: content.length 
      }, 'Content extracted');
      
      return content;
    } catch (error) {
      this.log.warn({ 
        url, 
        error: error instanceof Error ? error.message : String(error) 
      }, 'Error extracting content');
      
      // Return the original HTML on error
      return html;
    }
  }

  /**
   * Remove HTML comments from the content
   * @param html The HTML content
   * @returns The content without comments
   */
  private removeComments(html: string): string {
    return html.replace(/<!--[\s\S]*?-->/g, '');
  }

  /**
   * Extract the main content from an HTML page
   * @param html The HTML content
   * @returns The extracted main content
   */
  private extractMainContent(html: string): string {
    // Try to identify and extract the main content
    // This is a heuristic approach that looks for the most likely main content elements
    
    // Define potential main content element selectors in order of priority
    const mainContentSelectors = [
      // Common main content elements
      { regex: /<main[^>]*>([\s\S]*?)<\/main>/i, priority: 10 },
      { regex: /<article[^>]*>([\s\S]*?)<\/article>/i, priority: 9 },
      { regex: /<div[^>]*(?:id|class)=["'](?:content|main|post|entry|blog-content)[^>]*>([\s\S]*?)<\/div>/i, priority: 8 },
      { regex: /<div[^>]*(?:id|class)=["'](?:main-content|page-content|article-content|entry-content|post-content)[^>]*>([\s\S]*?)<\/div>/i, priority: 7 },
      { regex: /<section[^>]*(?:id|class)=["'](?:content|main|post|entry)[^>]*>([\s\S]*?)<\/section>/i, priority: 6 },
      { regex: /<body[^>]*>([\s\S]*?)<\/body>/i, priority: 0 }, // Fallback to body
    ];
    
    // Find all matches
    const matches = mainContentSelectors
      .map(selector => {
        const match = html.match(selector.regex);
        return match ? { content: match[1], priority: selector.priority } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b!.priority - a!.priority);
    
    // Return the highest priority match, or the original HTML if no matches
    return matches.length > 0 ? matches[0]!.content : html;
  }

  /**
   * Clean up HTML content by removing unwanted elements and normalizing whitespace
   * @param html The HTML content to clean
   * @returns The cleaned content
   */
  private cleanContent(html: string): string {
    // Remove common non-content elements
    let content = html;
    
    // Remove script, style, nav, header, footer elements
    content = content.replace(/<script[\s\S]*?<\/script>/g, '');
    content = content.replace(/<style[\s\S]*?<\/style>/g, '');
    content = content.replace(/<nav[\s\S]*?<\/nav>/g, '');
    content = content.replace(/<header[\s\S]*?<\/header>/g, '');
    content = content.replace(/<footer[\s\S]*?<\/footer>/g, '');
    
    // Remove common ads, sidebars, and social media containers
    content = content.replace(/<div[^>]*(?:id|class)=["'](?:sidebar|widget|ads|advertisement|social|share|related|recommended)[^>]*>[\s\S]*?<\/div>/gi, '');
    
    // Remove excess whitespace
    content = content.replace(/\s+/g, ' ');
    
    // Convert HTML to plain text
    content = this.htmlToPlainText(content);
    
    // Remove excessive line breaks
    content = content.replace(/\n{3,}/g, '\n\n');
    
    return content.trim();
  }

  /**
   * Convert HTML to plain text
   * @param html The HTML content
   * @returns The plain text content
   */
  private htmlToPlainText(html: string): string {
    // Replace common block elements with line breaks
    let text = html.replace(/<\/(?:p|div|section|article|h[1-6]|br|li|dd|dt)>/gi, '$&\n');
    
    // Replace horizontal rules with line breaks
    text = text.replace(/<hr[^>]*>/gi, '\n');
    
    // Add double line breaks for headings
    text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n$1\n');
    
    // Remove all remaining HTML tags
    text = text.replace(/<[^>]*>/g, '');
    
    // Decode common HTML entities
    text = this.decodeHtmlEntities(text);
    
    return text.trim();
  }

  /**
   * Decode common HTML entities
   * @param text The text with HTML entities
   * @returns The decoded text
   */
  private decodeHtmlEntities(text: string): string {
    const entities: { [key: string]: string } = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&nbsp;': ' ',
      '&copy;': '©',
      '&reg;': '®',
      '&trade;': '™',
      '&mdash;': '—',
      '&ndash;': '–',
      '&bull;': '•',
      '&hellip;': '…',
      '&ldquo;': '"',
      '&rdquo;': '"',
      '&lsquo;': "'",
      '&rsquo;': "'",
    };
    
    // Replace known entities
    let decoded = text;
    for (const [entity, char] of Object.entries(entities)) {
      decoded = decoded.replace(new RegExp(entity, 'g'), char);
    }
    
    // Replace numeric entities (decimal)
    decoded = decoded.replace(/&#(\d+);/g, (_, codepoint) => 
      String.fromCodePoint(parseInt(codepoint, 10))
    );
    
    // Replace numeric entities (hexadecimal)
    decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_, codepoint) => 
      String.fromCodePoint(parseInt(codepoint, 16))
    );
    
    return decoded;
  }
}
