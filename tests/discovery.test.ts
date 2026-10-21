import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { rm } from 'node:fs/promises';
import { discover, tasksFromPages } from '../server/discovery.ts';
import { testApp, session } from './helpers.ts';
let env: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  env = await testApp();
});
afterAll(async () => {
  await env?.app.close();
  if (env) await rm(env.dir, { recursive: true, force: true });
});
describe('real browser discovery', () => {
  it('walks same-origin links with budgets, discovers forms and HTTP failure evidence', async () => {
    const s = session(`${env.base}/demo`);
    const pages = await discover(s, `${env.dir}/artifacts`, new AbortController().signal, () => {});
    expect(pages).toHaveLength(6);
    expect(new Set(pages.map((p) => p.url)).size).toBe(6);
    expect(pages.every((p) => p.url.startsWith(env.base))).toBe(true);
    expect(pages.find((p) => p.url.endsWith('/sale'))?.status).toBe(500);
    expect(pages.some((p) => p.forms.some((f) => f.required === 2))).toBe(true);
    expect(pages.find((p) => p.url.endsWith('/login'))?.inputs).toEqual(
      expect.arrayContaining([
        { label: '邮箱', type: 'email', required: true },
        { label: '密码', type: 'password', required: true },
      ]),
    );
    expect(tasksFromPages(s, pages).some((t) => t.kind === 'navigation')).toBe(true);
    expect(pages[0].screenshot).toContain('/artifacts/');
  });
  it('honors page/depth budgets and an already cancelled signal', async () => {
    const s = session(`${env.base}/demo`);
    s.options.maxPages = 1;
    s.options.maxDepth = 0;
    expect(
      await discover(s, `${env.dir}/artifacts`, new AbortController().signal, () => {}),
    ).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(discover(s, `${env.dir}/artifacts`, controller.signal, () => {})).rejects.toThrow(
      '停止',
    );
  });
});
