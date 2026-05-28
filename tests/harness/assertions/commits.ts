// tests/harness/assertions/commits.ts — CommitMatcher implementation.
//
// Reads a commit object via isomorphic-git, parses the subject + the
// four `Dome-*` trailers (and any additional trailer lines), exposes
// matchers against the parsed shape.
//
// Trailer parsing mirrors what `git interpret-trailers --parse` would
// produce: the contiguous block of `Key: value` lines at the end of the
// commit message, separated from the body by a blank line. The shape
// is deliberately simple — Dome's engine commits always end with the
// canonical four trailers in a contiguous block.

import { expect } from "bun:test";
import fs from "node:fs";
import git from "isomorphic-git";

import { findGitRoot } from "../../../src/git";
import type { CommitMatcher, Harness } from "../types";

export class CommitMatcherImpl implements CommitMatcher {
  constructor(
    private readonly h: Harness,
    private readonly commitRef: string,
  ) {}

  async toHaveAllTrailers(required: ReadonlyArray<string>): Promise<void> {
    const c = await this.readCommit();
    const missing = required.filter((k) => c.trailers[k] === undefined);
    expect(
      missing.length,
      `commit ${c.oid.slice(0, 7)} "${c.subject}" is missing trailers: ${missing.join(", ")}\n` +
        `present trailers: ${Object.keys(c.trailers).join(", ") || "(none)"}`,
    ).toBe(0);
  }

  async toHaveTrailerValues(expected: Record<string, string>): Promise<void> {
    const c = await this.readCommit();
    const mismatches: string[] = [];
    for (const [key, want] of Object.entries(expected)) {
      const got = c.trailers[key];
      if (got !== want) {
        mismatches.push(`  ${key}: expected="${want}" actual="${got ?? "(missing)"}"`);
      }
    }
    expect(
      mismatches.length,
      `commit ${c.oid.slice(0, 7)} "${c.subject}" trailer mismatches:\n${mismatches.join("\n")}`,
    ).toBe(0);
  }

  async toHaveSubjectMatching(pattern: RegExp): Promise<void> {
    const c = await this.readCommit();
    expect(
      pattern.test(c.subject),
      `commit ${c.oid.slice(0, 7)} subject "${c.subject}" did not match ${pattern}`,
    ).toBe(true);
  }

  async toHaveParent(expectedParent: string): Promise<void> {
    const c = await this.readCommit();
    expect(
      c.parents.includes(expectedParent),
      `commit ${c.oid.slice(0, 7)} parents=[${c.parents.join(", ")}] does not include ${expectedParent}`,
    ).toBe(true);
  }

  // ----- internals --------------------------------------------------------

  private async readCommit(): Promise<{
    oid: string;
    subject: string;
    message: string;
    trailers: Record<string, string>;
    parents: ReadonlyArray<string>;
  }> {
    const root = await findGitRoot(this.h.vaultPath);
    if (root === null) {
      throw new Error(
        `CommitMatcher: vault ${this.h.vaultPath} is not inside a git repo`,
      );
    }
    const result = await git.readCommit({ fs, dir: root, oid: this.commitRef });
    const msg = result.commit.message;
    const lines = msg.split("\n");
    const subject = lines[0] ?? "";
    return {
      oid: result.oid,
      subject,
      message: msg,
      trailers: parseTrailers(msg),
      parents: result.commit.parent ?? [],
    };
  }
}

// ----- trailer parser -------------------------------------------------------

/**
 * Parse the trailing `Key: value` block from a commit message. The Dome
 * convention puts the trailers in a contiguous block at the end of the
 * message, separated from the body by a blank line (per
 * `git interpret-trailers --parse` semantics).
 *
 * Implementation: walk the message backwards from the last non-empty line.
 * Lines matching `<token>: <value>` are accumulated as trailers; the first
 * non-matching line terminates the block. The token portion must not
 * contain whitespace (canonical git trailer syntax).
 */
function parseTrailers(message: string): Record<string, string> {
  const lines = message.split("\n");
  const trailers: Record<string, string> = {};
  let i = lines.length - 1;
  // Skip a trailing blank line if present.
  while (i >= 0 && lines[i] !== undefined && lines[i]!.trim().length === 0) {
    i--;
  }
  // Walk upward while lines match the `Token: value` shape.
  for (; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s+(.*)$/.exec(line);
    if (match === null) break;
    const [, key, value] = match;
    if (key === undefined || value === undefined) break;
    trailers[key] = value;
  }
  return trailers;
}

// Exported so the always-true invariant can reuse the same parser without
// piping through a class instance.
export const _parseTrailers = parseTrailers;
