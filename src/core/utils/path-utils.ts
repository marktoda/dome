/**
 * Simple path utilities for vault operations.
 */

import path from 'node:path';
import { config } from './config.js';

export type RelPath = string;
export type AbsPath = string;

export const toAbs = (relPath: string): string => 
  path.join(config.DOME_VAULT_PATH, relPath);

export const toRel = (absPath: string): string => 
  path.relative(config.DOME_VAULT_PATH, absPath);

export const isRel = (p: string): boolean => 
  !path.isAbsolute(p);

export const isAbs = (p: string): boolean => 
  path.isAbsolute(p);