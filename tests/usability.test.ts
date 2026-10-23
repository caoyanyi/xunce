import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { testApp, task } from './helpers.ts';
import { diagnose } from '../server/diagnostics.ts';
import type { Snapshot } from '../shared/types.ts';

let env: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  env = await testApp();
});
afterAll(async () => {
  await env?.app.close();
  if (env) await rm(env.dir, { recursive: true, force: true });
});
describe('assertion failure diagnostics', () => {
  it.each([
    '',
    'HTTP 404',
    'API_KEY 未配置',
    'URL 不匹配 / waitForURL',
    'Timeout: timed out',
    'Assertion failed: 断言不存在',
    '执行已中断 / closed',
  ])('prioritizes assertion failure codes over message matching: %s', (message) => {
    expect(diagnose(message, 'url_mismatch').title).toBe('页面地址未达到预期');
    expect(diagnose(message, 'link_mismatch').title).toBe('可见链接未达到预期');
  });
  it('explains full URL comparison and requires an explicit path-only choice', () => {
    const { advice } = diagnose('', 'url_mismatch');
    for (const detail of [
      '断言证据',
      '实际 URL',
      '预期 URL',
      'exact',
      'query',
      'hash',
      'origin',
      'pathname',
      '显式设置 match: "path"',
    ])
      expect(advice).toContain(detail);
    expect(advice).toContain('不要为通过测试而放宽预期');
  });
  it('keeps visible-link text and href paired without suggesting a click or inferring absence from truncated evidence', () => {
    const { advice } = diagnose('', 'link_mismatch');
    for (const detail of [
      '同一个可见链接',
      '实际文本',
      'href',
      '预期文本',
      'URL',
      'query/hash',
      '不点击链接',
      'linksTruncated',
      '未列出不代表链接不存在',
    ])
      expect(advice).toContain(detail);
    expect(advice).toContain('不要拼接不同链接');
    expect(advice).toContain('不要求当前页面跳转');
  });
  it('retains message-based fallback diagnostics when no failure code is supplied', () => {
    expect(diagnose('HTTP 404').title).toBe('目标服务返回错误');
    expect(diagnose('URL 不匹配').title).toBe('页面地址未达到预期');
    expect(diagnose('Timeout').title).toBe('等待操作超时');
  });
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
  it.each([false, true])(
    'reports login capabilities accurately with planner configured=%s and Midscene absent',
    async (configured) => {
      const { createServer } = await import('node:http');
      let requests = 0;
      const s = env.store.createSession(`${env.base}/demo`, {
        engine: 'playwright',
        allowWrites: true,
      });
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
      const provider = createServer((_req, res) => {
        requests += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    tasks: [
                      {
                        title: '登录页地址检查',
                        description: '只校验页面地址，不自动填写登录',
                        url: s.targetUrl,
                        priority: 'P1',
                        steps: [
                          { action: 'goto', url: s.targetUrl },
                          { action: 'assertUrl', url: s.targetUrl },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        );
      });
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
      vi.stubEnv('PLANNER_API_KEY', configured ? 'local-test-key' : '');
      vi.stubEnv('PLANNER_MODEL', 'local-test-model');
      vi.stubEnv(
        'PLANNER_BASE_URL',
        `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      );
      vi.stubEnv('MIDSCENE_MODEL_API_KEY', '');
      vi.stubEnv('MIDSCENE_MODEL_NAME', '');
      vi.stubEnv('MIDSCENE_MODEL_FAMILY', '');
      try {
        env.orchestrator.start(s.id, 'plan', '检查登录流程');
        await env.orchestrator.waitForIdle();
        const snapshot = env.store.snapshot(s.id)!;
        const planned = snapshot.tasks.filter((task) => task.source === 'model');
        const warning = snapshot.jobs?.at(-1)?.warning;
        const message = env.store.list('messages', s.id).at(-1)?.content;
        expect(snapshot.jobs?.at(-1)?.status).toBe('completed');
        expect(requests).toBe(configured ? 1 : 0);
        expect(planned).toHaveLength(configured ? 1 : 0);
        if (configured) {
          expect(warning).toContain('可规划并执行结构化 Playwright 任务');
          expect(warning).not.toContain('本次仅使用 DOM');
          expect(message).toContain('模型规划新增 1 项结构化或视觉业务任务');
          expect(planned[0].engine).toBe('playwright');
          env.orchestrator.start(s.id, 'run', '', [planned[0].id]);
          await env.orchestrator.waitForIdle();
          expect(env.store.snapshot(s.id)!.runs).toMatchObject([
            { taskId: planned[0].id, engine: 'playwright', status: 'passed' },
          ]);
        } else {
          expect(warning).toContain('尚未配置规划模型，本次仅使用 DOM 规则发现');
          expect(message).toContain('配置规划模型后可增加结构化业务任务');
        }
      } finally {
        vi.unstubAllEnvs();
        await new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
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
