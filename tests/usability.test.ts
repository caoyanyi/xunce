import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { testApp, task } from './helpers.ts';
import type { Snapshot } from '../shared/types.ts';

let env: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  env = await testApp();
});
afterAll(async () => {
  await env?.app.close();
  if (env) await rm(env.dir, { recursive: true, force: true });
});
describe('usable workspace workflows', () => {
  it('applies partial settings without resetting other existing options', async () => {
    const s = env.store.createSession(`${env.base}/demo`, {
      engine: 'playwright',
      maxPages: 3,
      maxDepth: 1,
      allowWrites: true,
    });
    const response = await env.app.inject({
      method: 'PATCH',
      url: `/api/sessions/${s.id}`,
      payload: { options: { maxPages: 4 } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().options).toEqual({
      engine: 'playwright',
      maxPages: 4,
      maxDepth: 1,
      allowWrites: true,
    });
  });
  it('does not reset omitted fields when disabling or archiving legacy tasks', async () => {
    const s = env.store.createSession(`${env.base}/demo`);
    const original = env.store.put(
      'tasks',
      task(s.targetUrl, {
        id: randomUUID(),
        sessionId: s.id,
        title: 'legacy',
        priority: 'P0',
        description: '原有说明',
        steps: [{ action: 'click', selector: 'button' }],
      }),
    );
    const response = await env.app.inject({
      method: 'PATCH',
      url: `/api/sessions/${s.id}/tasks/${original.id}`,
      payload: { archived: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      description: '原有说明',
      priority: 'P0',
      revision: 1,
      archived: true,
    });
  });
  it('surfaces a planner failure on the job and preserves the old visual assets', async () => {
    const { createServer } = await import('node:http');
    const provider = createServer((_req, res) => res.writeHead(429).end());
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const s = env.store.createSession(`${env.base}/demo`, { engine: 'playwright' });
    env.store.put('pages', {
      id: randomUUID(),
      sessionId: s.id,
      url: s.targetUrl,
      title: 'Demo',
      status: 200,
      depth: 0,
      links: [],
      forms: [],
      text: 'Ready for testing',
    });
    const old = env.store.put(
      'tasks',
      task(s.targetUrl, { id: randomUUID(), sessionId: s.id, engine: 'midscene', source: 'model' }),
    );
    vi.stubEnv('PLANNER_API_KEY', 'local-test-key');
    vi.stubEnv('PLANNER_MODEL', 'local-test-model');
    vi.stubEnv(
      'PLANNER_BASE_URL',
      `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    );
    vi.stubEnv('MIDSCENE_MODEL_API_KEY', 'local-test-key');
    vi.stubEnv('MIDSCENE_MODEL_NAME', 'local-test-model');
    vi.stubEnv('MIDSCENE_MODEL_FAMILY', 'local-test-family');
    try {
      env.orchestrator.start(s.id, 'plan');
      await env.orchestrator.waitForIdle();
      const snapshot = env.store.snapshot(s.id)!;
      expect(snapshot.jobs?.at(-1)?.warning).toContain('模型规划未完成');
      expect(snapshot.tasks.find((task) => task.id === old.id)?.archived).not.toBe(true);
      expect(snapshot.runs).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('runs queued sessions in FIFO order and accounts for each job independently', async () => {
    const sessions = [1, 2, 3].map(() =>
      env.store.createSession(`${env.base}/demo`, { engine: 'playwright' }),
    );
    for (const s of sessions)
      env.store.put('tasks', task(s.targetUrl, { id: randomUUID(), sessionId: s.id }));
    const jobs = sessions.map((s) => env.orchestrator.start(s.id, 'run'));
    expect(env.orchestrator.runtime().queued.map((job) => job.sessionId)).toEqual(
      sessions.slice(1).map((s) => s.id),
    );
    await env.orchestrator.waitForIdle();
    const completed = jobs.map((job) => env.store.get('jobs', job.id)!);
    expect(completed.map((job) => job.status)).toEqual(['completed', 'completed', 'completed']);
    expect(
      completed.every((job) => job.total === 1 && job.passed === 1 && job.completed === 1),
    ).toBe(true);
    expect(Date.parse(completed[1].startedAt!)).toBeGreaterThanOrEqual(
      Date.parse(completed[0].finishedAt!),
    );
    expect(env.orchestrator.runtime().queued).toHaveLength(0);
  });
  it('allows preparing a write-task draft while read-only, but rejects execution before creating a job', async () => {
    const s = env.store.createSession(`${env.base}/demo`, { engine: 'playwright' });
    const path = `/api/sessions/${s.id}`;
    const created = await env.app.inject({
      method: 'POST',
      url: `${path}/tasks`,
      payload: {
        title: '交互草稿',
        url: s.targetUrl,
        engine: 'playwright',
        kind: 'form',
        steps: [
          { action: 'goto', url: s.targetUrl },
          { action: 'fill', selector: 'input', value: 'fixture' },
          { action: 'assertPage' },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().risk).toBe('write');
    expect(
      (await env.app.inject({ method: 'POST', url: `${path}/run`, payload: {} })).statusCode,
    ).toBe(400);
    expect(env.store.snapshot(s.id)!.jobs).toHaveLength(0);
    expect(env.store.snapshot(s.id)!.runs).toHaveLength(0);
  });
  it('answers a question without starting a browser job or replacing the session goal', async () => {
    const session = env.store.createSession(`${env.base}/demo`);
    env.store.updateSession(session.id, { goal: '检查登录流程' });
    const response = await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: '为什么不能自动登录？' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().mode).toBe('explain');
    expect(env.orchestrator.isBusy()).toBe(false);
    expect(env.store.snapshot(session.id)!.session.goal).toBe('检查登录流程');
    expect(env.store.list('messages', session.id).at(-1)?.content).toContain('交互');
  });
  it('persists options independently and edits task revisions without deleting old run definitions', async () => {
    const session = env.store.createSession(`${env.base}/demo`);
    const path = `/api/sessions/${session.id}`;
    const settings = await env.app.inject({
      method: 'PATCH',
      url: path,
      payload: { name: '登录回归', options: { maxPages: 2, allowWrites: false } },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().name).toBe('登录回归');
    const created = await env.app.inject({
      method: 'POST',
      url: `${path}/tasks`,
      payload: {
        title: '原任务',
        url: session.targetUrl,
        engine: 'playwright',
        kind: 'smoke',
        steps: [{ action: 'goto', url: session.targetUrl }, { action: 'assertPage' }],
      },
    });
    const original = created.json();
    await env.app.inject({
      method: 'POST',
      url: `${path}/run`,
      payload: { taskIds: [original.id] },
    });
    await env.orchestrator.waitForIdle();
    const changed = await env.app.inject({
      method: 'PATCH',
      url: `${path}/tasks/${original.id}`,
      payload: { expectedRevision: 1, title: '修订后的任务' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().revision).toBe(2);
    expect(changed.json().edited).toBe(true);
    const snapshot = env.store.snapshot(session.id)!;
    expect(snapshot.runs[0].taskSnapshot?.title).toBe('原任务');
    expect(snapshot.runs[0].taskRevision).toBe(1);
    expect(
      (
        await env.app.inject({
          method: 'PATCH',
          url: `${path}/tasks/${original.id}`,
          payload: { expectedRevision: 1, title: '过时修改' },
        })
      ).statusCode,
    ).toBe(409);
    await env.app.inject({
      method: 'PATCH',
      url: `${path}/tasks/${original.id}`,
      payload: { archived: true },
    });
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: `${path}/run`,
          payload: { taskIds: [original.id] },
        })
      ).statusCode,
    ).toBe(400);
    expect(env.store.snapshot(session.id)!.runs).toHaveLength(1);
  });
  it('queues a different session, exposes its position and cancels it without interrupting the active one', async () => {
    const first = env.store.createSession(`${env.base}/demo`, {
      engine: 'playwright',
      maxPages: 1,
    });
    const second = env.store.createSession(`${env.base}/demo`, { engine: 'playwright' });
    env.store.put('tasks', task(second.targetUrl, { id: randomUUID(), sessionId: second.id }));
    await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${first.id}/chat`,
      payload: { message: '只探索站点' },
    });
    const queued = await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${second.id}/run`,
      payload: {},
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json().job.status).toBe('queued');
    const runtime = (await env.app.inject('/api/runtime')).json();
    expect(runtime.active.sessionId).toBe(first.id);
    expect(runtime.queued[0].sessionId).toBe(second.id);
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: `/api/sessions/${second.id}/cancel`,
          payload: {},
        })
      ).json().cancelled,
    ).toBe(true);
    await env.orchestrator.waitForIdle();
    expect(env.store.snapshot(first.id)!.session.status).toBe('completed');
    expect(env.store.snapshot(second.id)!.session.status).toBe('cancelled');
    expect(env.store.snapshot(second.id)!.runs).toHaveLength(0);
  });
  it('continues pending work without rerunning passed or failed tasks', async () => {
    const session = env.store.createSession(`${env.base}/demo`, { engine: 'playwright' });
    for (const status of ['passed', 'failed', 'pending', 'cancelled'] as const)
      env.store.put(
        'tasks',
        task(session.targetUrl, { id: randomUUID(), sessionId: session.id, status }),
      );
    const response = await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/run`,
      payload: { mode: 'continue' },
    });
    expect(response.statusCode).toBe(202);
    await env.orchestrator.waitForIdle();
    const result = (await env.app.inject(`/api/sessions/${session.id}`)).json<Snapshot>();
    expect(result.runs).toHaveLength(2);
    expect(result.jobs?.at(-1)).toMatchObject({ total: 2, completed: 2, passed: 2, failed: 0 });
  });
});
