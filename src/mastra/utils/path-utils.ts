export type RelPath = string & { __brand: 'RelPath' };
export type AbsPath = string & { __brand: 'AbsPath' };

import path from 'node:path';
import { config } from '../core/config.js';

/**
 * Convert a vault-relative note path (e.g. "projects/alpha.md") to an absolute
 * filesystem path inside the configured vault folder.
 */
export function toAbs(relPath: RelPath): AbsPath {
  if (path.isAbsolute(relPath)) {
    // Already absolute – just brand it.
    return relPath as unknown as AbsPath;
  }
  return path.join(config.DOME_VAULT_PATH, relPath) as AbsPath;
}

/**
 * Convert an absolute path *inside the vault* back to its vault-relative form.
 * If the absolute path lies outside the vault an error is thrown – callers
 * should never feed external paths here.
 */
export function toRel(absPath: AbsPath | string): RelPath {
  if (!path.isAbsolute(absPath)) {
    // Already relative – brand and return.
    return absPath as unknown as RelPath;
  }

  const rel = path.relative(config.DOME_VAULT_PATH, absPath);
  if (rel.startsWith('..')) {
    throw new Error(`Path ${absPath} is outside of the vault (${config.DOME_VAULT_PATH}).`);
  }
  return rel as unknown as RelPath;
}

export function isRel(p: string): p is RelPath {
  return !path.isAbsolute(p);
}

export function isAbs(p: string): p is AbsPath {
  return path.isAbsolute(p);
} 