Tsunami Service File Filtering Design Document

1. Current State Analysis
   After analyzing the tsunami service codebase, I've identified the current filtering mechanisms in the GithubProvider's pull method:

// Current filtering in github.ts (line 89)
if (f.status === 'removed' || f.changes > MAX || dedup.has(f.filename)) continue;
This basic filtering:

Skips removed files
Skips files that are too large (>1MB)
Skips files already processed in the current sync
However, this doesn't address filtering out "garbage" files like configs, gas snapshots, etc.

2. Proposed Approaches Evaluation
   2.1. .tsunamiignore File Approach
   Pros:

Static, predictable filtering rules
Familiar pattern for developers (similar to .gitignore)
Repository owners can control what gets indexed
No computational overhead during runtime
Transparent and auditable
Can be checked into version control
Works offline without external dependencies
Cons:

Requires manual maintenance
Needs to be added to each repository
May need periodic updates as project structure changes
Default patterns may not fit all repositories
2.2. AI Processing Approach
Pros:

Adaptive filtering without manual configuration
Could potentially identify low-value files based on content
No need for repository owners to maintain ignore files
Could improve over time with feedback
Cons:

Computational overhead during processing
Potential for false positives/negatives
Less predictable than static rules
Requires training data and model maintenance
May still need to download files before filtering them
Adds complexity and external dependencies
2.3. Additional Approach: Built-in Default Patterns
Pros:

Works without any repository configuration
Consistent filtering across all repositories
No additional computational overhead
Can be updated centrally
Cons:

May not be tailored to specific repository needs
Could filter out important files in some projects
One-size-fits-all approach has limitations 3. Comprehensive Solution Design
Based on the user's preference for the static approach, I propose a layered filtering solution with the .tsunamiignore file as the primary mechanism, supplemented by built-in default patterns.

3.1. Solution Overview
Built-in Default Patterns: Implement a set of default patterns to filter common "garbage" files
.tsunamiignore File Support: Allow repositories to define custom ignore patterns
Override Mechanism: Enable repositories to override default patterns if needed
Configuration Options: Provide service-level configuration to control filtering behavior
3.2. Implementation Components
3.2.1. Ignore Pattern Processor
Create a new utility class to handle pattern matching:

// services/tsunami/src/utils/ignorePatternProcessor.ts
export class IgnorePatternProcessor {
private patterns: string[] = [];

constructor(defaultPatterns: string[] = []) {
this.patterns = [...defaultPatterns];
}

addPatterns(patterns: string[]): void {
this.patterns.push(...patterns);
}

shouldIgnore(filePath: string): boolean {
// Implementation of pattern matching logic
// Similar to .gitignore pattern matching
return this.patterns.some(pattern => this.matchesPattern(filePath, pattern));
}

private matchesPattern(filePath: string, pattern: string): boolean {
// Pattern matching implementation
// Handle glob patterns, negation with !, etc.
}
}
3.2.2. Default Patterns Configuration
Define default patterns for common "garbage" files:

// services/tsunami/src/config/defaultIgnorePatterns.ts
export const DEFAULT_IGNORE_PATTERNS = [
// Build artifacts
'node_modules/**',
'dist/**',
'build/**',
'.next/**',

// Package manager files
'package-lock.json',
'yarn.lock',
'pnpm-lock.yaml',

// Test snapshots and coverage
'**/**snapshots**/**',
'**/coverage/**',
'\*_/_.snap',

// Gas snapshots
'\*_/_.gas',

// Generated files
'**/_.generated._',
'**/_.min._',

// Config files
'.eslintrc*',
'.prettierrc*',
'.babelrc*',
'tsconfig*.json',
'jest.config.\*',

// Logs
'**/\*.log',
'logs/**',

// Cache
'.cache/**',
'**/.DS_Store',

// Large binary files
'**/\*.zip',
'**/_.tar',
'\*\*/_.gz',
'**/\*.jar',
'**/_.war',
'\*\*/_.mp4',
'**/\*.mp3',
'**/_.avi',
'\*\*/_.mov',

// Images (optional, could be commented out by default)
// '**/\*.jpg',
// '**/_.jpeg',
// '\*\*/_.png',
// '**/\*.gif',
// '**/\*.svg',
];
3.2.3. .tsunamiignore File Fetcher
Create a service to fetch and parse .tsunamiignore files:

// services/tsunami/src/services/ignoreFileService.ts
import { getLogger } from '@dome/logging';

export class IgnoreFileService {
private log = getLogger();

constructor(private headers: Record<string, string>) {}

async fetchIgnoreFile(owner: string, repo: string, sha: string): Promise<string[] | null> {
const url = `https://api.github.com/repos/${owner}/${repo}/contents/.tsunamiignore?ref=${sha}`;

    try {
      const response = await fetch(url, { headers: this.headers });

      if (!response.ok) {
        if (response.status === 404) {
          this.log.debug({ owner, repo }, 'No .tsunamiignore file found');
          return null;
        }

        this.log.warn(
          { owner, repo, status: response.status },
          'Failed to fetch .tsunamiignore file'
        );
        return null;
      }

      const data = await response.json();
      if (!data.content) return null;

      const content = atob(data.content.replace(/\n/g, ''));
      return this.parseIgnoreFile(content);
    } catch (err) {
      this.log.warn(
        { owner, repo, err: (err as Error).message },
        'Error fetching .tsunamiignore file'
      );
      return null;
    }

}

private parseIgnoreFile(content: string): string[] {
return content
.split('\n')
.map(line => line.trim())
.filter(line => line && !line.startsWith('#'));
}
}
3.2.4. Integration with GithubProvider
Modify the GithubProvider to use the new filtering components:

// Modified section in services/tsunami/src/providers/github.ts
import { DEFAULT_IGNORE_PATTERNS } from '../config/defaultIgnorePatterns';
import { IgnorePatternProcessor } from '../utils/ignorePatternProcessor';
import { IgnoreFileService } from '../services/ignoreFileService';

export class GithubProvider implements Provider {
private log = getLogger();
private headers: Record<string, string>;
private ignoreFileService: IgnoreFileService;

constructor(env: Bindings) {
const token = (env as any).GITHUB_TOKEN ?? '';
this.headers = {
Accept: 'application/vnd.github.v3+json',
'X-GitHub-Api-Version': '2022-11-28',
'User-Agent': UA,
...(token && { Authorization: `token ${token}` }),
};
this.ignoreFileService = new IgnoreFileService(this.headers);
}

async pull({ userId, resourceId, cursor }: PullOpts): Promise<PullResult> {
const [owner, repo] = resourceId.split('/');
if (!owner || !repo) throw new Error(`Bad resourceId "${resourceId}" (want owner/repo)`);

    const t0 = Date.now();
    this.log.info({ owner, repo, cursor }, 'github: pull start');

    const commits = await this.getNewCommits(owner, repo, cursor);
    if (!commits.length) return { contents: [], newCursor: null };

    // Initialize the ignore pattern processor with default patterns
    const ignoreProcessor = new IgnorePatternProcessor(DEFAULT_IGNORE_PATTERNS);

    // Try to fetch custom .tsunamiignore file from the repository
    const customPatterns = await this.ignoreFileService.fetchIgnoreFile(owner, repo, commits[0].sha);
    if (customPatterns) {
      ignoreProcessor.addPatterns(customPatterns);
      this.log.info(
        { owner, repo, patternCount: customPatterns.length },
        'Custom .tsunamiignore patterns loaded'
      );
    }

    const dedup = new Set<string>();
    const puts: SiloSimplePutInput[] = [];
    let skippedFiles = 0;

    for (const c of commits) {
      const files = await this.getFiles(owner, repo, c.sha);
      for (const f of files) {
        // Enhanced filtering logic
        if (
          f.status === 'removed' ||
          f.changes > MAX ||
          dedup.has(f.filename) ||
          ignoreProcessor.shouldIgnore(f.filename)
        ) {
          if (ignoreProcessor.shouldIgnore(f.filename)) {
            skippedFiles++;
          }
          continue;
        }

        dedup.add(f.filename);

        // Rest of the existing code...
      }
    }

    metrics.timing('github.pull.latency_ms', Date.now() - t0);
    metrics.increment('github.pull.files_processed', puts.length);
    metrics.increment('github.pull.files_skipped', skippedFiles);

    this.log.info(
      { resourceId, files: puts.length, skipped: skippedFiles, commits: commits.length },
      'github: pull done'
    );

    return { contents: puts, newCursor: commits[0].sha };

}
}
3.2.5. Configuration Options
Add configuration options to control filtering behavior:

// services/tsunami/src/config/filterConfig.ts
export interface FilterConfig {
// Whether to use default ignore patterns
useDefaultPatterns: boolean;

// Whether to use .tsunamiignore files
useIgnoreFiles: boolean;

// Maximum file size in bytes (default 1MB)
maxFileSize: number;

// Whether to log skipped files
logSkippedFiles: boolean;
}

export const DEFAULT*FILTER_CONFIG: FilterConfig = {
useDefaultPatterns: true,
useIgnoreFiles: true,
maxFileSize: 1 * 1024 \_ 1024, // 1MB
logSkippedFiles: false,
}; 4. Implementation Plan
4.1. Required Code Changes
Create new files:

services/tsunami/src/utils/ignorePatternProcessor.ts
services/tsunami/src/config/defaultIgnorePatterns.ts
services/tsunami/src/services/ignoreFileService.ts
services/tsunami/src/config/filterConfig.ts
Modify existing files:

services/tsunami/src/providers/github.ts
4.2. Implementation Steps
Phase 1: Core Implementation

Implement the IgnorePatternProcessor class
Define default ignore patterns
Implement the IgnoreFileService
Integrate with GithubProvider
Phase 2: Configuration and Metrics

Add configuration options
Add metrics for filtered files
Add logging for filtered files
Phase 3: Documentation and Testing

Document the filtering functionality
Create example .tsunamiignore files
Test with various repositories
4.3. Integration with Existing Codebase
The solution integrates with the existing codebase by:

Enhancing the filtering logic in the GithubProvider's pull method
Using the existing logging and metrics infrastructure
Maintaining the same interface for the Provider implementation
Following the project's coding style and patterns 5. Documentation
5.1. User Documentation
Create a documentation file explaining how to use the filtering functionality:

# Tsunami File Filtering

The Tsunami service supports filtering files during ingestion to exclude "garbage" files like build artifacts, logs, and configuration files.

## Using .tsunamiignore

You can create a `.tsunamiignore` file in the root of your repository to specify which files should be excluded from ingestion. The syntax is similar to `.gitignore`.

### Example .tsunamiignore

Node.js
node_modules/
package-lock.json
yarn.lock

Build artifacts
dist/
build/
.next/

Test files
tests/
**/.test.js
**/.spec.js
\*\*/snapshots/

Configuration
.eslintrc*
.prettierrc*
tsconfig.json

Override default patterns (include these files)
!important-config.json

## Default Ignored Patterns

The Tsunami service includes default patterns to ignore common "garbage" files. These patterns are applied automatically unless overridden in your `.tsunamiignore` file.

To include a file that would be ignored by default, add it with a `!` prefix in your `.tsunamiignore` file:

Include this specific config file despite the default ignore pattern
!tsconfig.special.json

6. Conclusion
   The proposed solution provides a comprehensive approach to filtering "garbage" files in the tsunami service, focusing on the .tsunamiignore file approach as preferred by the user. It combines the flexibility of repository-specific ignore patterns with sensible defaults, while maintaining the existing architecture and performance characteristics of the service.

The implementation is designed to be:

Efficient: Filtering happens early in the process, avoiding unnecessary downloads
Flexible: Repositories can customize filtering through .tsunamiignore files
Maintainable: Clear separation of concerns and well-documented code
Extensible: The architecture allows for future enhancements, such as AI-based filtering
This solution addresses the immediate need to filter out "garbage" files while laying the groundwork for more sophisticated filtering approaches in the future.
