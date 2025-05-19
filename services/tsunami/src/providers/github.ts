/**
 * GitHub Provider
 *
 * This provider is responsible for pulling content from GitHub repositories
 * and injecting metadata headers before sending to Silo.
 */
import { SiloSimplePutInput, ContentCategory, MimeType } from '@dome/common';
import { Provider, PullOpts, PullResult } from '.';
import { getLogger, metrics } from '@dome/common';
import {
  createGitHubMetadata,
  getLanguageFromPath,
  injectMetadataHeader,
} from '../services/metadataHeaderService';
import { IgnoreFileService } from '../services/ignoreFileService';
import { BaseProvider } from './base';
import type { ServiceEnv } from '../resourceObject';

/* ─── constants ────────────────────────────────────────────────────────── */

const API = 'https://api.github.com';
const UA = 'Tsunami-Service/1.0.0 (+https://github.com/dome/tsunami)';
const MAX = 1 * 1024 * 1024; // 1 MiB

const MIME: Record<string, MimeType> = {
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.jsx': 'application/javascript',
  '.tsx': 'application/typescript',
  '.sol': 'application/solidity',
  '.rs': 'application/rust',
  '.html': 'text/html',
  '.css': 'text/css',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.py': 'application/python',
  '.txt': 'text/plain',
};
const PLAINTEXT: MimeType = 'text/plain';

/* ─── helpers ──────────────────────────────────────────────────────────── */

const ext = (path: string) => path.slice(path.lastIndexOf('.')).toLowerCase();

function mimeFor(path: string): MimeType {
  return MIME[ext(path)] ?? PLAINTEXT;
}

function b64(body: string) {
  return atob(body.replace(/\n/g, ''));
}

type Commit = {
  sha: string;
  commit: { message: string; author: { name: string; email: string; date: string } };
};
type FilesResp = { files?: GitFile[] };
type GitFile = { filename: string; status: string; changes: number };
type ContentResp = { content?: string; encoding?: string; size: number };

export class GithubProvider extends BaseProvider implements Provider {
  private headers: Record<string, string>;
  private ignoreFileService: IgnoreFileService;

  constructor(env: ServiceEnv) {
    super();
    const token = (env as any).GITHUB_TOKEN ?? '';
    this.headers = {
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(token && { Authorization: `token ${token}` }),
    };

    // Initialize file filtering components
    this.ignoreFileService = new IgnoreFileService(token);
  }

  /* ─── Provider impl. ─────────────────────────────────────────────────── */

  async pull({ userId, resourceId, cursor }: PullOpts): Promise<PullResult> {
    const [owner, repo] = resourceId.split('/');
    if (!owner || !repo) throw new Error(`Bad resourceId "${resourceId}" (want owner/repo)`);

    const t0 = Date.now();
    this.log.info({ owner, repo, cursor }, 'github: pull start');

    const commits = await this.getNewCommits(owner, repo, cursor);
    if (!commits.length) return { contents: [], newCursor: null };

    // Reset the ignore pattern processor for this pull operation
    this.resetIgnorePatterns();

    // Fetch ignore patterns for this repository
    const ignorePatterns = await this.ignoreFileService.getIgnorePatterns(owner, repo);
    if (ignorePatterns.length > 0) {
      this.addIgnorePatterns(ignorePatterns);
      this.log.info(
        { owner, repo, patternCount: ignorePatterns.length },
        'Loaded ignore patterns for repository',
      );
    }

    const dedup = new Set<string>();
    const puts: SiloSimplePutInput[] = [];
    let filteredFiles = 0;

    for (const c of commits) {
      const files = await this.getFiles(owner, repo, c.sha);
      for (const f of files) {
        // Check if file should be filtered based on ignore patterns
        if (this.isIgnored(f.filename)) {
          if (this.filterConfig.logFilteredFiles) {
            this.log.debug({ path: f.filename }, 'File filtered by ignore pattern');
          }
          filteredFiles++;
          continue;
        }

        // Apply existing filters
        if (f.status === 'removed' || f.changes > MAX || dedup.has(f.filename)) continue;
        dedup.add(f.filename);

        const content = await this.getFile(owner, repo, f.filename, c.sha);
        if (!content) continue;

        // Create metadata for the file
        const metadata = createGitHubMetadata(
          resourceId,
          f.filename,
          c.commit.author.date,
          getLanguageFromPath(f.filename),
          content.length,
        );

        // Inject metadata header into content
        const contentWithMetadata = injectMetadataHeader(content, metadata);

        // Determine the content category - Markdown files should be 'document', others are 'code'
        const category = f.filename.endsWith('.md') ? 'document' : 'code';

        puts.push({
          content: contentWithMetadata,
          category: category as ContentCategory,
          mimeType: mimeFor(f.filename),
          userId,
          metadata: {
            repository: resourceId,
            path: f.filename,
            commitSha: c.sha,
            commitMessage: c.commit.message,
            author: c.commit.author.name,
            authorEmail: c.commit.author.email,
            commitDate: c.commit.author.date,
            htmlUrl: `https://github.com/${owner}/${repo}/blob/${c.sha}/${f.filename}`,
          },
        });
      }
    }

    // Record metrics
    metrics.timing('github.pull.latency_ms', Date.now() - t0);
    metrics.increment('github.pull.files_processed', puts.length);

    // Add metrics for filtered files if enabled
    if (this.filterConfig.trackFilterMetrics) {
      metrics.increment('github.pull.files_filtered', filteredFiles);
    }

    this.log.info(
      { resourceId, files: puts.length, filtered: filteredFiles, commits: commits.length },
      'github: pull done',
    );

    return { contents: puts, newCursor: commits[0].sha };
  }

  /* ─── GitHub API wrappers ────────────────────────────────────────────── */

  private async json<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '<no-body>');
      this.log.error({ url, status: res.status, body }, 'github: request failed');
      throw new Error(`GitHub ${res.status}: ${res.statusText}`);
    }

    // log rate-limit once per response
    const left = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (left) this.log.debug({ left, reset, url }, 'github: rate-limit');

    return res.json() as Promise<T>;
  }

  private async getNewCommits(
    owner: string,
    repo: string,
    cursor: string | null,
  ): Promise<Commit[]> {
    const url = `${API}/repos/${owner}/${repo}/commits?per_page=100`;
    const all = await this.json<Commit[]>(url);

    if (!cursor) return all; // first sync

    const idx = all.findIndex(c => c.sha === cursor);
    return idx === -1 ? all : all.slice(0, idx);
  }

  private async getFiles(owner: string, repo: string, sha: string): Promise<GitFile[]> {
    const url = `${API}/repos/${owner}/${repo}/commits/${sha}`;
    const { files = [] } = await this.json<FilesResp>(url);
    return files;
  }

  private async getFile(
    owner: string,
    repo: string,
    path: string,
    sha: string,
  ): Promise<string | null> {
    const url = `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${sha}`;
    try {
      const { content, encoding, size } = await this.json<ContentResp>(url);
      if (!content || size > MAX) return null;
      return encoding === 'base64' ? b64(content) : content;
    } catch (err) {
      this.log.warn({ owner, repo, path, sha, err: (err as Error).message }, 'github: file skip');
      return null;
    }
  }
}
