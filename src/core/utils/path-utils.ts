/**
 * Simple path utilities for vault operations.
 */

import path from 'node:path';
import { config } from './config.js';

export type RelPath = string;
export type AbsPath = string;

export const toAbs = (inputPath: string): string => {
  // If already absolute, return as-is
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  // Convert relative path to absolute
  return path.join(config.DOME_VAULT_PATH, inputPath);
};

export const toRel = (inputPath: string): string => {
  // If already relative, return as-is
  if (!path.isAbsolute(inputPath)) {
    return inputPath;
  }
  // Convert absolute path to relative
  return path.relative(config.DOME_VAULT_PATH, inputPath);
};

export const isRel = (p: string): boolean => 
  !path.isAbsolute(p);

export const isAbs = (p: string): boolean => 
  path.isAbsolute(p);