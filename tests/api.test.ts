import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { testApp } from './helpers.ts';
import type { Session, Snapshot } from '../shared/types.ts';
let env: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  env = await testApp();
});
afterAll(async () => {
  await env?.app.close();
  if (env) await rm(env.dir, { recursive: true, force: true });
});
describe('HTTP API and full orchestration', () => {
  it('rejects invalid inputs and cross-site writes while accepting arbitrary hostnames', async () => {
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { targetUrl: 'file:///etc/passwd' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { options: { maxPages: 100 } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: { origin: 'https://evil.test' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await env.app.inject({ url: '/api/config', headers: { host: 'console.example.test' } }))
        .statusCode,
    ).toBe(200);
    expect((await env.app.inject('/api/sessions/missing')).statusCode).toBe(404);
    const config = (await env.app.inject('/api/config')).body;
    expect(config).not.toContain('API_KEY');
  });
  it('discovers, executes, identifies the demo failure and retries without losing history', async () => {
    const created = await env.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { targetUrl: `${env.base}/demo`, options: { engine: 'playwright', maxPages: 6 } },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json<Session>();
    const chat = await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: '探索商城并自动测试' },
    });
    expect(chat.statusCode).toBe(202);
    const conflict = await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: '再测一次' },
    });
    expect(conflict.statusCode).toBe(409);
    const progress = await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: '状态' },
    });
    expect(progress.statusCode).toBe(200);
    await env.orchestrator.waitForIdle();
    let snapshot = (await env.app.inject(`/api/sessions/${session.id}`)).json<Snapshot>();
    expect(snapshot.session.status).toBe('completed');
    expect(snapshot.tasks.filter((t) => t.status === 'failed')).toHaveLength(1);
    expect(snapshot.tasks.filter((t) => t.status === 'passed').length).toBeGreaterThan(3);
    expect(snapshot.runs.find((r) => r.status === 'failed')?.error).toContain('HTTP 500');
    const firstCount = snapshot.runs.length;
    const failed = snapshot.tasks.find((t) => t.status === 'failed')!;
    const retry = await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/run`,
      payload: { failedOnly: true },
    });
    expect(retry.statusCode).toBe(202);
    await env.orchestrator.waitForIdle();
    snapshot = env.store.snapshot(session.id)!;
    expect(snapshot.runs).toHaveLength(firstCount + 1);
    expect(snapshot.runs.filter((r) => r.taskId === failed.id)).toHaveLength(2);
    const report = await env.app.inject(`/api/sessions/${session.id}/report`);
    expect(report.headers['content-disposition']).toContain('attachment');
    expect(report.json().runs).toHaveLength(firstCount + 1);
    const screenshot = snapshot.runs.find((r) => r.screenshot)!.screenshot!;
    expect((await env.app.inject(screenshot)).headers['content-type']).toContain('image/png');
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: `/api/sessions/${session.id}/run`,
          payload: { taskIds: ['00000000-0000-4000-a000-000000000000'] },
        })
      ).statusCode,
    ).toBe(400);
  }, 90000);
  it('stops discovery and releases the single-worker slot', async () => {
    const session = env.store.createSession(`${env.base}/demo`, { engine: 'playwright' });
    env.orchestrator.start(session.id, 'auto');
    expect(env.orchestrator.cancel(session.id)).toBe(true);
    await env.orchestrator.waitForIdle();
    expect(env.store.get('sessions', session.id)?.status).toBe('cancelled');
    expect(env.orchestrator.isBusy()).toBe(false);
  });
});

describe('conversation and task-management API branches', () => {
  it('supports discovery-only, deduplication, validated task creation and selected execution', async () => {
    const session = env.store.createSession(`${env.base}/demo`, {
      engine: 'playwright',
      maxPages: 1,
    });
    const chatPath = `/api/sessions/${session.id}/chat`;
    let response = await env.app.inject({
      method: 'POST',
      url: chatPath,
      payload: { message: '只探索站点并发现任务' },
    });
    expect(response.statusCode).toBe(202);
    await env.orchestrator.waitForIdle();
    const original = env.store.list('tasks', session.id)[0];
    expect(original.status).toBe('pending');
    expect(env.store.list('runs', session.id)).toHaveLength(0);
    const question = await env.app.inject({
      method: 'POST',
      url: chatPath,
      payload: { message: '有哪些失败任务？' },
    });
    expect(question.statusCode).toBe(200);
    expect(env.orchestrator.isBusy()).toBe(false);
    await env.app.inject({ method: 'POST', url: chatPath, payload: { message: '只探索站点' } });
    await env.orchestrator.waitForIdle();
    expect(env.store.list('tasks', session.id)).toHaveLength(1);
    expect(env.store.list('tasks', session.id)[0].id).toBe(original.id);
    const created = await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/tasks`,
      payload: {
        title: '验证品牌',
        url: session.targetUrl,
        kind: 'smoke',
        engine: 'playwright',
        steps: [
          { action: 'goto', url: session.targetUrl },
          { action: 'assertText', text: '让生活' },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().source).toBe('manual');
    response = await env.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/run`,
      payload: { taskIds: [created.json().id] },
    });
    expect(response.statusCode).toBe(202);
    await env.orchestrator.waitForIdle();
    expect(env.store.list('runs', session.id)).toHaveLength(1);
    expect(env.store.list('runs', session.id)[0].status).toBe('passed');
    response = await env.app.inject({
      method: 'POST',
      url: chatPath,
      payload: { message: '只探索站点', targetUrl: 'https://example.com' },
    });
    expect(response.statusCode).toBe(400);
    response = await env.app.inject({
      method: 'POST',
      url: chatPath,
      payload: { message: '停止' },
    });
    expect(response.statusCode).toBe(202);
    expect(env.store.list('messages', session.id).at(-1)?.content).toContain('没有运行');
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: `/api/sessions/${session.id}/cancel`,
          payload: {},
        })
      ).json().cancelled,
    ).toBe(false);
  });
  it('requires a target and executable tasks, and rejects unsupported step/engine combinations', async () => {
    const session = env.store.createSession('');
    const path = `/api/sessions/${session.id}`;
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: `${path}/chat`,
          payload: { message: '测试一下' },
        })
      ).statusCode,
    ).toBe(400);
    env.store.updateSession(session.id, { targetUrl: `${env.base}/demo` });
    expect(
      (await env.app.inject({ method: 'POST', url: `${path}/run`, payload: {} })).statusCode,
    ).toBe(400);
    const response = await env.app.inject({
      method: 'POST',
      url: `${path}/tasks`,
      payload: {
        title: 'invalid',
        url: `${env.base}/demo`,
        engine: 'tester-army',
        kind: 'form',
        steps: [{ action: 'validateForm', index: 0 }],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('LAN console requests', () => {
  it('allows the machine LAN authority and same-origin writes while keeping other origins blocked', async () => {
    const { networkInterfaces } = await import('node:os');
    const ip =
      Object.values(networkInterfaces())
        .flat()
        .find((address) => address?.family === 'IPv4' && !address.internal)?.address || '127.0.0.1';
    const host = `${ip}:4318`;
    const config = await env.app.inject({ url: '/api/config', headers: { host } });
    expect(config.statusCode).toBe(200);
    expect(config.json().demoUrl).toBe(`${env.base}/demo`);
    const created = await env.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { host, origin: `http://${host}` },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: { host, origin: 'https://evil.test' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/sessions',
          headers: { host, origin: `http://${ip}:9999` },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('deployment hostnames and reverse proxies', () => {
  it.each(['http://console.example.test:8080', 'https://console.example.test:8080'])(
    'allows same-origin writes through %s',
    async (origin) => {
      const response = await env.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { host: 'console.example.test:8080', origin },
        payload: {},
      });
      expect(response.statusCode).toBe(201);
    },
  );
});
