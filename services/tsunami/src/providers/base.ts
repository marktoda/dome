import { getLogger } from '@dome/common';
import { IgnorePatternProcessor } from '../utils/ignorePatternProcessor';
import { DEFAULT_FILTER_CONFIG } from '../config/filterConfig';
import type { Provider, PullOpts, PullResult } from '.';

/**
 * BaseProvider
 *
 * Shared utilities for concrete provider implementations
 * – consistent logging setup
 * – ignore-pattern processing (e.g. .gitignore, custom filters)
 * – centralised filter-config so flags are aligned across providers
 *
 * Concrete providers should extend this class rather than re-implementing
 * the boiler-plate. They still need to implement the {@link pull} method.  */
export abstract class BaseProvider implements Provider {
  protected readonly log = getLogger();
  protected readonly ignorePatternProcessor = new IgnorePatternProcessor();
  protected readonly filterConfig = DEFAULT_FILTER_CONFIG;

  /**
   * Implement Provider#pull in subclasses.
   */
  abstract pull(opts: PullOpts): Promise<PullResult>;

  /** Check if the given path should be skipped according to ignore patterns */
  protected isIgnored(path: string): boolean {
    return this.ignorePatternProcessor.shouldIgnore(path);
  }

  /** Add ignore patterns read from provider-specific sources (.gitignore etc.) */
  protected addIgnorePatterns(patterns: string[]): void {
    this.ignorePatternProcessor.addPatterns(patterns);
  }

  /** Reset ignore-patterns between pulls */
  protected resetIgnorePatterns(): void {
    this.ignorePatternProcessor.clearPatterns();
  }
} 