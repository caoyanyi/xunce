import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../server/store.ts';
import { task } from './helpers.ts';
import { now } from '../shared/types.ts';
describe('SQLite persistence', () => {
  it('invalidates waiting CAPTCHA requests after restart', () => {
    const store = new Store(':memory:');
    try {
      const session = store.createSession('https://example.test/login');
      store.updateSession(session.id, { status: 'waiting_input' });
      store.put(
        'tasks',
        task(session.targetUrl, {
          id: 'waiting-task',
          sessionId: session.id,
          status: 'waiting_input',
        }),
      );
      store.put('runs', {
        id: 'waiting-run',
        sessionId: session.id,
        taskId: 'waiting-task',
        engine: 'playwright',
        status: 'waiting_input',
        startedAt: now(),
        pendingInput: {
          id: 'old-request',
          type: 'image_captcha',
          screenshot: '/artifacts/fixture.png',
          actualUrl: session.targetUrl,
          attempt: 1,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      });
      store.recoverInterrupted();
      const snapshot = store.snapshot(session.id)!;
      expect(snapshot.session.status).toBe('cancelled');
      expect(snapshot.tasks[0].status).toBe('cancelled');
      expect(snapshot.runs[0].status).toBe('cancelled');
      expect(snapshot.runs[0].pendingInput).toBeUndefined();
    } finally {
      store.close();
    }
  });
  it('persists complete history and recovers interrupted operations after reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'explorer-store-'));
    const path = join(dir, 'db.sqlite');
    let store = new Store(path);
    try {
      const session = store.createSession('https://example.com');
      store.message(session.id, 'user', '检查登录');
      store.updateSession(session.id, { status: 'running' });
      store.put(
        'tasks',
        task(session.targetUrl, { id: 'task', sessionId: session.id, status: 'running' }),
      );
      store.put('runs', {
        id: 'first',
        sessionId: session.id,
        taskId: 'task',
        status: 'passed',
        engine: 'playwright',
        startedAt: now(),
      });
      store.put('runs', {
        id: 'second',
        sessionId: session.id,
        taskId: 'task',
        status: 'running',
        engine: 'playwright',
        startedAt: now(),
      });
      store.close();
      store = new Store(path);
      store.recoverInterrupted();
      const result = store.snapshot(session.id)!;
      expect(result.session.status).toBe('cancelled');
      expect(result.runs.map((r) => r.status)).toEqual(['passed', 'cancelled']);
      expect(result.tasks[0].status).toBe('cancelled');
      expect(result.messages.some((m) => m.content.includes('重启'))).toBe(true);
      expect(store.snapshot('missing')).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true });
    }
  });
});

it('restores the latest committed result if a crash happened between run and task updates', () => {
  const store = new Store(':memory:');
  try {
    const session = store.createSession('https://example.com');
    store.put(
      'tasks',
      task(session.targetUrl, { id: 'committed', sessionId: session.id, status: 'running' }),
    );
    store.put('runs', {
      id: 'complete',
      sessionId: session.id,
      taskId: 'committed',
      status: 'passed',
      engine: 'playwright',
      startedAt: now(),
    });
    store.recoverInterrupted();
    expect(store.get('tasks', 'committed')?.status).toBe('passed');
  } finally {
    store.close();
  }
});
