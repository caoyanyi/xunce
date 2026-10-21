import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  now,
  optionsSchema,
  type Session,
  type Message,
  type Observation,
  type Task,
  type Run,
  type RunEvent,
  type Snapshot,
} from '../shared/types.ts';

type Records = {
  sessions: Session;
  messages: Message;
  pages: Observation;
  tasks: Task;
  runs: Run;
  events: RunEvent;
};
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS records_session ON records(kind,session_id)',
    );
  }
  put<K extends keyof Records>(kind: K, value: Records[K]): Records[K] {
    const sessionId = 'sessionId' in value ? value.sessionId : value.id;
    this.db
      .prepare(
        'INSERT INTO records(kind,id,session_id,body) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body',
      )
      .run(kind, value.id, sessionId, JSON.stringify(value));
    return value;
  }
  get<K extends keyof Records>(kind: K, id: string): Records[K] | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  list<K extends keyof Records>(kind: K, sessionId?: string): Records[K][] {
    const rows = sessionId
      ? this.db
          .prepare('SELECT body FROM records WHERE kind=? AND session_id=? ORDER BY rowid')
          .all(kind, sessionId)
      : this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid').all(kind);
    return rows.map((row) => JSON.parse(String(row.body)));
  }
  createSession(targetUrl: string, options: Partial<Session['options']> = {}): Session {
    return this.put('sessions', {
      id: randomUUID(),
      name: targetUrl ? new URL(targetUrl).hostname : '新的探索',
      targetUrl,
      status: 'idle',
      options: optionsSchema.parse(options),
      createdAt: now(),
      updatedAt: now(),
    });
  }
  updateSession(id: string, patch: Partial<Session>): Session {
    const session = this.get('sessions', id);
    if (!session) throw new Error('会话不存在');
    return this.put('sessions', { ...session, ...patch, id, updatedAt: now() });
  }
  message(sessionId: string, role: Message['role'], content: string) {
    return this.put('messages', { id: randomUUID(), sessionId, role, content, createdAt: now() });
  }
  event(sessionId: string, message: string, level: RunEvent['level'] = 'info', runId?: string) {
    return this.put('events', {
      id: randomUUID(),
      sessionId,
      runId,
      level,
      message,
      createdAt: now(),
    });
  }
  snapshot(id: string): Snapshot | undefined {
    const session = this.get('sessions', id);
    return session
      ? {
          session,
          messages: this.list('messages', id),
          pages: this.list('pages', id),
          tasks: this.list('tasks', id),
          runs: this.list('runs', id),
          events: this.list('events', id),
        }
      : undefined;
  }
  recoverInterrupted() {
    for (const run of this.list('runs'))
      if (run.status === 'running')
        this.put('runs', {
          ...run,
          status: 'cancelled',
          finishedAt: now(),
          error: '服务重启，执行已中断。可重新运行。',
        });
    for (const task of this.list('tasks'))
      if (task.status === 'running') {
        const latest = this.list('runs', task.sessionId)
          .filter((run) => run.taskId === task.id)
          .at(-1);
        this.put('tasks', {
          ...task,
          status:
            latest?.status === 'passed' || latest?.status === 'failed'
              ? latest.status
              : 'cancelled',
        });
      }
    for (const session of this.list('sessions'))
      if (['discovering', 'running'].includes(session.status)) {
        this.updateSession(session.id, { status: 'cancelled' });
        this.message(
          session.id,
          'assistant',
          '上次操作因服务重启而中断。已保留结果，可以重新探索或复跑。',
        );
      }
  }
  close() {
    this.db.close();
  }
}
