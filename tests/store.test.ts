import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../server/store.ts';
import { task } from './helpers.ts';
import { now } from '../shared/types.ts';
describe('SQLite persistence', () => {
  it('archives outdated plans while preserving edited/manual assets and immutable run snapshots', () => {
    const store = new Store(':memory:');
    try {
      const s = store.createSession('https://example.test');
      const first = task(s.targetUrl, { id: 'old', sessionId: s.id, title: '旧方案' });
      const edited = task(s.targetUrl, {
        id: 'edited',
        sessionId: s.id,
        title: '保留编辑',
        edited: true,
      });
      const manual = task(s.targetUrl, { id: 'manual', sessionId: s.id, source: 'manual' });
      [first, edited, manual].forEach((value) => store.put('tasks', value));
      store.put('runs', {
        id: 'history',
        sessionId: s.id,
        taskId: first.id,
        taskSnapshot: structuredClone(first),
        taskRevision: 1,
        engine: 'playwright',
        status: 'passed',
        startedAt: now(),
      });
      const next = task(s.targetUrl, { id: 'new', sessionId: s.id, title: '新方案' });
      store.reconcileTasks(s.id, [next], 'plan2');
      expect(store.get('tasks', 'old')?.archivedReason).toBe('replanned');
      expect(store.get('tasks', 'edited')?.archived).not.toBe(true);
      expect(store.get('tasks', 'manual')?.archived).not.toBe(true);
      expect(store.get('runs', 'history')?.taskSnapshot?.title).toBe('旧方案');
      store.reconcileTasks(
        s.id,
        [{ ...next, id: 'another', steps: [{ action: 'assertText', text: '新预期' }] }],
        'plan3',
      );
      expect(store.get('tasks', 'new')?.revision).toBe(2);
      expect(store.list('tasks', s.id)).toHaveLength(4);
    } finally {
      store.close();
    }
  });
  it('does not resurrect a user-archived task or overwrite a customized task', () => {
    const store = new Store(':memory:');
    try {
      const s = store.createSession('https://example.test');
      const archived = task(s.targetUrl, {
        id: 'archived',
        sessionId: s.id,
        archived: true,
        archivedReason: 'user',
      });
      const edited = task(s.targetUrl, {
        id: 'edited',
        sessionId: s.id,
        title: 'edited',
        edited: true,
        steps: [{ action: 'assertText', text: '手工修改' }],
      });
      store.put('tasks', archived);
      store.put('tasks', edited);
      const result = store.reconcileTasks(
        s.id,
        [
          { ...archived, id: 'replacement', archived: false },
          { ...edited, id: 'new-edit', steps: [{ action: 'assertPage' }] },
        ],
        'plan',
      );
      expect(result).toHaveLength(1);
      expect(result[0].steps).toEqual(edited.steps);
      expect(store.get('tasks', 'archived')?.archivedReason).toBe('user');
    } finally {
      store.close();
    }
  });
  it('cancels queued jobs on restart without executing them', () => {
    const store = new Store(':memory:');
    try {
      const s = store.createSession('https://example.test');
      store.updateSession(s.id, { status: 'queued' });
      store.put('jobs', {
        id: 'queued',
        sessionId: s.id,
        mode: 'run',
        status: 'queued',
        taskIds: [],
        total: 0,
        completed: 0,
        passed: 0,
        failed: 0,
        cancelled: 0,
        createdAt: now(),
      });
      store.recoverInterrupted();
      expect(store.snapshot(s.id)?.jobs?.[0].status).toBe('cancelled');
      expect(store.snapshot(s.id)?.session.status).toBe('cancelled');
    } finally {
      store.close();
    }
  });
  it('reconciles interrupted job counters from committed run records after restart', () => {
    const store = new Store(':memory:');
    try {
      const s = store.createSession('https://example.test');
      store.put('jobs', {
        id: 'partial',
        sessionId: s.id,
        mode: 'run',
        status: 'running',
        taskIds: ['a', 'b', 'c'],
        total: 3,
        completed: 0,
        passed: 0,
        failed: 0,
        cancelled: 0,
        createdAt: now(),
      });
      for (const [index, status] of ['passed', 'running'].entries())
        store.put('runs', {
          id: `r${index}`,
          sessionId: s.id,
          jobId: 'partial',
          taskId: `t${index}`,
          engine: 'playwright',
          status: status as 'passed' | 'running',
          startedAt: now(),
        });
      store.recoverInterrupted();
      expect(store.get('jobs', 'partial')).toMatchObject({
        status: 'cancelled',
        total: 3,
        completed: 2,
        passed: 1,
        cancelled: 1,
      });
    } finally {
      store.close();
    }
  });
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
