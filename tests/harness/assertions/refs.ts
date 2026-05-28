// tests/harness/assertions/refs.ts — RefMatcher implementation.
//
// One thin layer over the harness's `refs` / `git` read surfaces. Each
// method runs the assertion and surfaces an `expect()` failure via
// `bun:test`; methods never mutate harness state (only move methods do).
//
// Placeholders:
//   - "$HEAD"        — resolved via `h.refs.head()`.
//   - "$ADOPTED"     — resolved via `h.refs.adopted()` (null is a failure).
//
// Snapshot semantics: `toHaveAdvanced` / `toBeUnchanged` compare against
// the value captured by the most recent move (or `h.snapshot()`). The
// Harness factory `expectRef` is responsible for threading the snapshot
// in; this class is opaque to where the value came from.

import { expect } from "bun:test";

import type { Harness, RefMatcher } from "../types";
import { adoptedRefName } from "../../../src/adopted-ref";

export class RefMatcherImpl implements RefMatcher {
  constructor(
    private readonly h: Harness,
    private readonly refName: string,
    private readonly snapshotValue: string | null,
  ) {}

  async toEqual(other: string): Promise<void> {
    const actual = await this.resolveRef();
    const expected = await this.resolvePlaceholder(other);
    expect(
      actual,
      `expected ${this.refName} to equal ${expected ?? "(null)"}; got ${actual ?? "(null)"}`,
    ).toBe(expected);
  }

  async toEqualHead(): Promise<void> {
    const head = await this.h.refs.head();
    await this.toEqual(head);
  }

  async toHaveAdvanced(): Promise<void> {
    const current = await this.resolveRef();
    expect(
      current === this.snapshotValue,
      `expected ${this.refName} to have advanced from ${this.snapshotValue ?? "(null)"}; ` +
        `still at ${current ?? "(null)"}`,
    ).toBe(false);
  }

  async toBeUnchanged(): Promise<void> {
    const current = await this.resolveRef();
    expect(
      current,
      `expected ${this.refName} to be unchanged from ${this.snapshotValue ?? "(null)"}; ` +
        `now at ${current ?? "(null)"}`,
    ).toBe(this.snapshotValue);
  }

  async toBeAncestorOf(other: string): Promise<void> {
    const me = await this.resolveRef();
    const them = await this.resolvePlaceholder(other);
    if (me === null) {
      throw new Error(`toBeAncestorOf: ${this.refName} does not exist`);
    }
    if (them === null) {
      throw new Error(`toBeAncestorOf: target ref ${other} does not resolve`);
    }
    if (me === them) return; // trivially ancestor-or-equal
    const isAnc = await this.h.git.isAncestor(me, them);
    expect(
      isAnc,
      `expected ${this.refName} (${me.slice(0, 7)}) to be an ancestor of ${them.slice(0, 7)}`,
    ).toBe(true);
  }

  async toExist(): Promise<void> {
    const v = await this.resolveRef();
    expect(v, `expected ${this.refName} to exist`).not.toBeNull();
  }

  async toNotExist(): Promise<void> {
    const v = await this.resolveRef();
    expect(v, `expected ${this.refName} to not exist; got ${v ?? "(null)"}`).toBeNull();
  }

  // ----- internals --------------------------------------------------------

  private async resolveRef(): Promise<string | null> {
    if (this.refName === `refs/heads/${this.h.branch}`) {
      try {
        return await this.h.refs.head();
      } catch {
        return null;
      }
    }
    if (this.refName === adoptedRefName(this.h.branch)) {
      return this.h.refs.adopted(this.h.branch);
    }
    // Generic ref resolution via the git boundary. The GitView surface
    // doesn't expose a generic ref reader; we treat unknown refs as
    // "does not exist" rather than throw. Most scenarios will use the
    // two structural refs above.
    return null;
  }

  private async resolvePlaceholder(s: string): Promise<string | null> {
    if (s === "$HEAD") {
      try {
        return await this.h.refs.head();
      } catch {
        return null;
      }
    }
    if (s === "$ADOPTED") {
      return this.h.refs.adopted(this.h.branch);
    }
    return s;
  }
}
