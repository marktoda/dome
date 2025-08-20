import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import logger from '../core/utils/logger.js';
import { FileState } from './types.js';

export class FileStateStore {
  private state = new Map<string, FileState>();

  constructor(private readonly stateFile: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, FileState>;
      this.state = new Map(Object.entries(obj));
      logger.debug(`Loaded state for ${this.state.size} files`);
    } catch {
      logger.debug('No existing state file, starting fresh');
      this.state.clear();
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.stateFile);
    await fs.mkdir(dir, { recursive: true });

    const obj: Record<string, FileState> = {};
    for (const [k, v] of this.state.entries()) obj[k] = v;

    const tmp = `${this.stateFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    await fs.rename(tmp, this.stateFile); // atomic on same volume
    logger.debug(`Saved state for ${this.state.size} files`);
  }

  get(relativePath: string): FileState | undefined {
    return this.state.get(relativePath);
  }

  upsert(relativePath: string, hash: string, when = new Date()): void {
    this.state.set(relativePath, { hash, lastProcessed: when.toISOString() });
  }

  delete(relativePath: string): void {
    this.state.delete(relativePath);
  }

  /**
   * Returns hex sha256 of the file at absPath. Reads whole file; if you later
   * want streaming or mtime+size, this is the one place to swap strategy.
   */
  async computeHash(absPath: string): Promise<string> {
    const buf = await fs.readFile(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }
}