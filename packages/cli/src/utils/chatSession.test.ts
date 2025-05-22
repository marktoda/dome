import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

let tmpDir: string;

// Importing inside tests after mocking os.homedir
let getChatSession: typeof import('./chatSession').getChatSession;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dome-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  vi.resetModules();
  ({ getChatSession } = await import('./chatSession'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ChatSessionManager', () => {
  it('creates and persists a new session', () => {
    const manager = getChatSession(true);
    const id = manager.getSessionId();
    const sessionFile = path.join(tmpDir, '.dome', 'chat_sessions', `${id}.json`);
    expect(fs.existsSync(sessionFile)).toBe(true);
    manager.addUserMessage('hi');
    manager.addAssistantMessage('hello');
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    expect(data.messages).toHaveLength(2);
  });

  it('limits history to 20 messages', () => {
    const manager = getChatSession(true);
    for (let i = 0; i < 25; i++) {
      manager.addUserMessage(`msg ${i}`);
    }
    expect(manager.getMessages()).toHaveLength(20);
  });

  it('switches between sessions', () => {
    const manager = getChatSession(true);
    const first = manager.getSessionId();
    manager.createNewSession();
    const second = manager.getSessionId();
    expect(second).not.toBe(first);
    const switched = manager.switchSession(first);
    expect(switched).toBe(true);
    expect(manager.getSessionId()).toBe(first);
  });
});
