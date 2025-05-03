/**
 * RobotsChecker
 * 
 * This class is responsible for checking robots.txt files and determining
 * if a URL is allowed to be crawled according to the robots.txt rules.
 */
import { getLogger } from '@dome/common';

export class RobotsChecker {
  private log = getLogger();
  private rules: Map<string, RobotRule[]> = new Map();
  private loaded: boolean = false;
  private userAgent: string;
  private baseUrl: string = '';

  /**
   * Create a new RobotsChecker
   * @param userAgent The user agent to use for checking rules
   */
  constructor(userAgent: string) {
    this.userAgent = userAgent;
  }

  /**
   * Initialize the checker by fetching and parsing robots.txt
   * @param baseUrl The base URL of the website
   */
  async initialize(baseUrl: string): Promise<void> {
    this.baseUrl = baseUrl;
    const robotsUrl = new URL('/robots.txt', baseUrl).toString();
    
    try {
      this.log.info({ robotsUrl }, 'Fetching robots.txt');
      const response = await fetch(robotsUrl, {
        headers: {
          'User-Agent': this.userAgent
        }
      });
      
      if (!response.ok) {
        if (response.status === 404) {
          // No robots.txt - assume everything is allowed
          this.log.info({ robotsUrl }, 'No robots.txt found, all URLs allowed');
          this.loaded = true;
          return;
        }
        
        throw new Error(`Failed to fetch robots.txt: ${response.status} ${response.statusText}`);
      }
      
      const content = await response.text();
      this.parseRobotsTxt(content);
      this.loaded = true;
      this.log.info({ robotsUrl, ruleCount: this.countRules() }, 'Robots.txt parsed successfully');
    } catch (error) {
      this.log.warn({ 
        robotsUrl,
        error: error instanceof Error ? error.message : String(error) 
      }, 'Error loading robots.txt, defaulting to allow all');
      
      // Default to allowing everything on error
      this.loaded = true;
    }
  }

  /**
   * Check if a URL is allowed to be crawled
   * @param url The URL to check
   * @returns True if the URL is allowed, false otherwise
   */
  isAllowed(url: string): boolean {
    if (!this.loaded) {
      this.log.warn({ url }, 'Robots checker not initialized, defaulting to allow');
      return true;
    }
    
    // Normalize URL for comparison
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname + parsedUrl.search;
    
    // Find rules that apply to this user agent
    // Check in this order: specific user agent, * (all user agents)
    const ourUserAgent = this.extractUserAgentName(this.userAgent);
    
    for (const agentName of [ourUserAgent, '*']) {
      const agentRules = this.rules.get(agentName);
      if (!agentRules) continue;
      
      for (const rule of agentRules) {
        if (this.pathMatches(path, rule.path)) {
          return rule.allow;
        }
      }
    }
    
    // Default to allowed if no rules match
    return true;
  }

  /**
   * Parse robots.txt content into rules
   * @param content The content of the robots.txt file
   */
  private parseRobotsTxt(content: string): void {
    this.rules = new Map();
    
    const lines = content.split('\n');
    let currentAgent: string | null = null;
    
    for (let line of lines) {
      // Remove comments and trim whitespace
      line = line.split('#')[0].trim();
      if (!line) continue;
      
      // Parse directive and value
      const colonIndex = line.indexOf(':');
      const directive = colonIndex > 0 ? line.slice(0, colonIndex).trim().toLowerCase() : line.toLowerCase();
      const value = colonIndex > 0 ? line.slice(colonIndex + 1).trim() : '';
      
      if (directive === 'user-agent') {
        currentAgent = value.toLowerCase();
        if (!this.rules.has(currentAgent)) {
          this.rules.set(currentAgent, []);
        }
      } else if (directive === 'allow' && currentAgent && value) {
        this.addRule(currentAgent, value, true);
      } else if (directive === 'disallow' && currentAgent) {
        // Empty disallow means allow all
        if (!value) {
          // Allow all
          this.addRule(currentAgent, '/', true);
        } else {
          this.addRule(currentAgent, value, false);
        }
      }
    }
  }

  /**
   * Add a rule for a user agent
   * @param agent The user agent
   * @param path The path pattern
   * @param allow Whether the path is allowed or disallowed
   */
  private addRule(agent: string, path: string, allow: boolean): void {
    const rules = this.rules.get(agent) || [];
    rules.push({ path, allow });
    this.rules.set(agent, rules);
  }

  /**
   * Check if a path matches a robots.txt pattern
   * @param path The path to check
   * @param pattern The pattern from robots.txt
   * @returns True if the path matches the pattern
   */
  private pathMatches(path: string, pattern: string): boolean {
    // Convert robots.txt pattern to a regex pattern
    let regexPattern = pattern
      .replace(/\./g, '\\.')    // Escape dots
      .replace(/\?/g, '\\?')    // Escape question marks
      .replace(/\*/g, '.*');    // Convert * to .*
      
    // If pattern ends with $, it must match the end of the path
    if (regexPattern.endsWith('$')) {
      regexPattern = `^${regexPattern}`;
    } else {
      regexPattern = `^${regexPattern}`;
    }
    
    const regex = new RegExp(regexPattern);
    return regex.test(path);
  }

  /**
   * Extract the user agent name from the full user agent string
   * @param userAgent The full user agent string
   * @returns The user agent name
   */
  private extractUserAgentName(userAgent: string): string {
    // Extract the first part of the user agent string (before first slash)
    const match = userAgent.match(/^([^/]+)/);
    return match ? match[1].toLowerCase() : userAgent.toLowerCase();
  }

  /**
   * Count the total number of rules loaded
   * @returns The number of rules
   */
  private countRules(): number {
    let count = 0;
    for (const rules of this.rules.values()) {
      count += rules.length;
    }
    return count;
  }
}

/**
 * Represents a rule in robots.txt
 */
interface RobotRule {
  path: string;
  allow: boolean;
}
