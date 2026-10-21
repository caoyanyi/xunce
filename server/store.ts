import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  now,
  busyStatuses,
  optionsSchema,
  type Session,
  type Message,
  type Observation,
  type Task,
  type Run,
  type RunEvent,
  type Snapshot,
  type Job,
} from '../shared/types.ts';

type Records = {
  sessions: Session;
  messages: Message;
  pages: Observation;
  tasks: Task;
  runs: Run;
  events: RunEvent;
  jobs: Job;
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
  event(
    sessionId: string,
    message: string,
    level: RunEvent['level'] = 'info',
    runId?: string,
    jobId?: string,
  ) {
    return this.put('events', {
      id: randomUUID(),
      sessionId,
      runId,
      jobId,
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
          jobs: this.list('jobs', id),
        }
      : undefined;
  }
  recoverInterrupted() {
    for (const job of this.list('jobs'))
      if (busyStatuses.includes(job.status)) {
        const runs = this.list('runs', job.sessionId).filter((run) => run.jobId === job.id);
        this.put('jobs', {
          ...job,
          status: 'cancelled',
          activeTaskId: undefined,
          currentStep: undefined,
          completed: runs.length,
          passed: runs.filter((run) => run.status === 'passed').length,
          failed: runs.filter((run) => run.status === 'failed').length,
          cancelled: runs.filter((run) =>
            ['running', 'waiting_input', 'cancelled'].includes(run.status),
          ).length,
          finishedAt: now(),
          error: '服务重启，作业已中断。请继续未完成任务或重新运行。',
        });
      }
    for (const run of this.list('runs'))
      if (['running', 'waiting_input'].includes(run.status))
        this.put('runs', {
          ...run,
          status: 'cancelled',
          pendingInput: undefined,
          finishedAt: now(),
          error: '服务重启，执行已中断。可重新运行。',
        });
    for (const task of this.list('tasks'))
      if (['running', 'waiting_input'].includes(task.status)) {
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
      if (busyStatuses.includes(session.status)) {
        this.updateSession(session.id, { status: 'cancelled' });
        this.message(
          session.id,
          'assistant',
          '上次操作因服务重启而中断。已保留结果，可以重新探索或复跑。',
        );
      }
  }
  reconcileTasks(
    sessionId: string,
    generated: Task[],
    planId: string,
    sources: Task['source'][] = ['dom', 'model'],
  ): Task[] {
    const existing = this.list('tasks', sessionId);
    const selected: Task[] = [];
    const identity = (task: Task) => JSON.stringify([task.source, task.url, task.kind, task.title]);
    const definition = (task: Task) =>
      JSON.stringify([
        task.title,
        task.description,
        task.url,
        task.kind,
        task.priority,
        task.engine,
        task.risk,
        task.steps,
      ]);
    this.db.exec('BEGIN');
    try {
      for (const candidate of generated) {
        const previous = existing.find((task) => identity(task) === identity(candidate));
        if (previous?.archivedReason === 'user') continue;
        if (previous?.edited) {
          selected.push(previous);
          continue;
        }
        const changed = previous && definition(previous) !== definition(candidate);
        selected.push(
          this.put('tasks', {
            ...candidate,
            id: previous?.id || candidate.id,
            createdAt: previous?.createdAt || candidate.createdAt,
            updatedAt: now(),
            revision: (previous?.revision || 1) + (changed ? 1 : 0),
            status: previous && !changed ? previous.status : 'pending',
            enabled: previous?.enabled ?? true,
            archived: false,
            archivedReason: undefined,
            planId,
          }),
        );
      }
      const ids = new Set(selected.map((task) => task.id));
      for (const task of existing)
        if (
          sources.includes(task.source) &&
          task.source !== 'manual' &&
          !task.edited &&
          task.archivedReason !== 'user' &&
          !ids.has(task.id)
        )
          this.put('tasks', { ...task, archived: true, archivedReason: 'replanned' });
      this.db.exec('COMMIT');
      return selected;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
