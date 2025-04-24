import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_IGNORE_PATTERNS } from '../../src/config/defaultIgnorePatterns';
import { IgnorePatternProcessor } from '../../src/utils/ignorePatternProcessor';

describe('DEFAULT_IGNORE_PATTERNS', () => {
  it('should be an array of strings', () => {
    expect(Array.isArray(DEFAULT_IGNORE_PATTERNS)).toBe(true);
    expect(DEFAULT_IGNORE_PATTERNS.length).toBeGreaterThan(0);
    DEFAULT_IGNORE_PATTERNS.forEach(pattern => {
      expect(typeof pattern).toBe('string');
    });
  });

  it('should include patterns for common "garbage" files', () => {
    // Check for common build artifacts
    expect(DEFAULT_IGNORE_PATTERNS).toContain('node_modules/**');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('dist/**');
    expect(DEFAULT_IGNORE_PATTERNS).toContain('build/**');

    // Check for package manager files
    expect(DEFAULT_IGNORE_PATTERNS.some(p => p.includes('package-lock.json'))).toBe(true);
    expect(DEFAULT_IGNORE_PATTERNS.some(p => p.includes('yarn.lock'))).toBe(true);
    expect(DEFAULT_IGNORE_PATTERNS.some(p => p.includes('pnpm-lock.yaml'))).toBe(true);

    // Check for test snapshots
    expect(DEFAULT_IGNORE_PATTERNS.some(p => p.includes('__snapshots__'))).toBe(true);
    expect(DEFAULT_IGNORE_PATTERNS.some(p => p.includes('*.snap'))).toBe(true);

    // Check for config files
    expect(DEFAULT_IGNORE_PATTERNS.some(p => p.includes('.eslintrc'))).toBe(true);
    expect(DEFAULT_IGNORE_PATTERNS.some(p => p.includes('.prettierrc'))).toBe(true);
    expect(DEFAULT_IGNORE_PATTERNS.some(p => p.includes('tsconfig'))).toBe(true);
  });

  describe('Integration with IgnorePatternProcessor', () => {
    let processor: IgnorePatternProcessor;

    beforeEach(() => {
      processor = new IgnorePatternProcessor(DEFAULT_IGNORE_PATTERNS);
    });

    it('should filter node_modules files', () => {
      expect(processor.shouldIgnore('node_modules/react/index.js')).toBe(true);
      expect(processor.shouldIgnore('src/components/node_modules/react/index.js')).toBe(true);
    });

    it('should filter build artifacts', () => {
      expect(processor.shouldIgnore('dist/bundle.js')).toBe(true);
      expect(processor.shouldIgnore('build/index.js')).toBe(true);
      expect(processor.shouldIgnore('.next/server/pages/index.js')).toBe(true);
    });

    it('should filter package manager files', () => {
      expect(processor.shouldIgnore('package-lock.json')).toBe(true);
      expect(processor.shouldIgnore('yarn.lock')).toBe(true);
      expect(processor.shouldIgnore('pnpm-lock.yaml')).toBe(true);
    });

    it('should filter test snapshots', () => {
      expect(processor.shouldIgnore('__snapshots__/component.snap')).toBe(true);
      expect(processor.shouldIgnore('src/components/__snapshots__/button.snap')).toBe(true);
      expect(processor.shouldIgnore('src/components/button.snap')).toBe(true);
    });

    it('should filter config files', () => {
      expect(processor.shouldIgnore('.eslintrc.js')).toBe(true);
      expect(processor.shouldIgnore('.prettierrc.json')).toBe(true);
      expect(processor.shouldIgnore('tsconfig.json')).toBe(true);
    });

    it('should filter logs and cache files', () => {
      expect(processor.shouldIgnore('npm-debug.log')).toBe(true);
      expect(processor.shouldIgnore('logs/error.log')).toBe(true);
      expect(processor.shouldIgnore('.cache/webpack/cache.json')).toBe(true);
      expect(processor.shouldIgnore('.DS_Store')).toBe(true);
    });

    it('should filter large binary files', () => {
      expect(processor.shouldIgnore('archive.zip')).toBe(true);
      expect(processor.shouldIgnore('data.tar.gz')).toBe(true);
      expect(processor.shouldIgnore('video.mp4')).toBe(true);
      expect(processor.shouldIgnore('audio.mp3')).toBe(true);
    });

    it('should not filter source code files', () => {
      expect(processor.shouldIgnore('src/index.js')).toBe(false);
      expect(processor.shouldIgnore('src/components/Button.tsx')).toBe(false);
      expect(processor.shouldIgnore('lib/utils.js')).toBe(false);
      expect(processor.shouldIgnore('README.md')).toBe(false);
    });
  });
});
