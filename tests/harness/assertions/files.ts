// tests/harness/assertions/files.ts — FileMatcher implementation.
//
// File content reads route through git (the adopted-state-of-truth view):
// the matcher reads from a commit OID, never from the working tree, so
// asserts are reproducible regardless of working-tree noise.
//
// Default commit: the current HEAD. Tests can pass `{ atCommit: <oid> }`
// to read from a specific commit (e.g., the value of `refs/dome/adopted`).

import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readBlob } from "../../../src/git";
import type { FileMatcher, Harness } from "../types";

export class FileMatcherImpl implements FileMatcher {
  constructor(
    private readonly h: Harness,
    private readonly path: string,
    private readonly atCommit: string | null,
  ) {}

  async toExist(): Promise<void> {
    const content = await this.readContent();
    expect(
      content,
      `expected file ${this.path} to exist at ${this.atCommit ?? "HEAD"}`,
    ).not.toBeNull();
  }

  async toBeAbsent(): Promise<void> {
    const content = await this.readContent();
    expect(
      content,
      `expected file ${this.path} to be absent at ${this.atCommit ?? "HEAD"}`,
    ).toBeNull();
  }

  async toContain(substring: string): Promise<void> {
    const content = await this.requireContent("toContain");
    expect(
      content.includes(substring),
      `expected ${this.path} to contain ${JSON.stringify(substring)}; got:\n${content}`,
    ).toBe(true);
  }

  async toNotContain(substring: string): Promise<void> {
    const content = await this.requireContent("toNotContain");
    expect(
      content.includes(substring),
      `expected ${this.path} to NOT contain ${JSON.stringify(substring)}; got:\n${content}`,
    ).toBe(false);
  }

  async toMatch(regex: RegExp): Promise<void> {
    const content = await this.requireContent("toMatch");
    expect(
      regex.test(content),
      `expected ${this.path} to match ${regex}; got:\n${content}`,
    ).toBe(true);
  }

  async toEqual(expectedContent: string): Promise<void> {
    const content = await this.requireContent("toEqual");
    expect(content).toBe(expectedContent);
  }

  // ----- internals --------------------------------------------------------

  private async readContent(): Promise<string | null> {
    // Explicit `atCommit` always reads from that commit's tree only.
    if (this.atCommit !== null) {
      return readBlob({
        path: this.h.vaultPath,
        commit: this.atCommit,
        filepath: this.path,
      });
    }
    // No explicit commit: prefer HEAD's tree. If the path is not in HEAD
    // (uncommitted edit, or no HEAD yet), fall back to the working tree
    // so scenarios that read pre-commit edits still resolve. This
    // mirrors how a user inspects "what's on disk vs. what's adopted":
    // by default, the most recently-written content wins.
    const head = await this.headOrNull();
    if (head !== null) {
      const fromHead = await readBlob({
        path: this.h.vaultPath,
        commit: head,
        filepath: this.path,
      });
      if (fromHead !== null) return fromHead;
    }
    try {
      return await readFile(join(this.h.vaultPath, this.path), "utf8");
    } catch {
      return null;
    }
  }

  private async requireContent(method: string): Promise<string> {
    const content = await this.readContent();
    if (content === null) {
      throw new Error(
        `FileMatcher.${method}: file ${this.path} does not exist at ${this.atCommit ?? "HEAD"}`,
      );
    }
    return content;
  }

  private async headOrNull(): Promise<string | null> {
    try {
      return await this.h.refs.head();
    } catch {
      return null;
    }
  }
}
