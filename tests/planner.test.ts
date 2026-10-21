import { describe, it, expect } from 'vitest';
import { parseModelTasks } from '../server/planner.ts';
import { tasksFromPages } from '../server/discovery.ts';
import type { Observation } from '../shared/types.ts';
import { session } from './helpers.ts';
const s = session();
const page: Observation = {
  id: 'page',
  sessionId: s.id,
  url: s.targetUrl,
  title: 'Demo',
  status: 200,
  depth: 0,
  text: 'hello',
  links: [],
  forms: [{ index: 0, name: '登录', required: 2 }],
};
const visual = {
  title: '视觉验证',
  description: '验证首页内容',
  url: page.url,
  priority: 'P1',
  steps: [
    { action: 'goto', url: page.url },
    { action: 'aiAssert', instruction: '首页标题清晰可见' },
  ],
};
describe('evidence-grounded planning', () => {
  it('accepts a deterministic browser URL assertion as an outcome', () => {
    const [task] = parseModelTasks(
      {
        tasks: [
          {
            ...visual,
            steps: [
              { action: 'goto', url: page.url },
              { action: 'assertUrl', url: page.url },
            ],
          },
        ],
      },
      s,
      [page],
    );
    expect(task.steps.at(-1)).toEqual({ action: 'assertUrl', url: page.url });
  });
  it('generates deterministic tasks with actual assertions and explicit engines', () => {
    const tasks = tasksFromPages(s, [page]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].steps.at(-1)?.action).toBe('assertPage');
    expect(tasks[1].steps.at(-1)?.action).toBe('validateForm');
    expect(tasks[1].engine).toBe('playwright');
  });
  it('parses model tasks without accepting arbitrary executable code', () => {
    const [task] = parseModelTasks({ tasks: [visual] }, s, [page]);
    expect(task.engine).toBe('midscene');
    expect(task.risk).toBe('read');
    expect(() =>
      parseModelTasks(
        { tasks: [{ ...visual, steps: [{ action: 'eval', code: 'arbitrary()' }] }] },
        s,
        [page],
      ),
    ).toThrow();
  });
  it('rejects unobserved pages, outside URLs, missing assertions and unapproved writes', () => {
    expect(() =>
      parseModelTasks({ tasks: [{ ...visual, url: 'https://evil.test' }] }, s, [page]),
    ).toThrow('未观察');
    expect(() =>
      parseModelTasks(
        {
          tasks: [
            {
              ...visual,
              steps: [
                { action: 'goto', url: page.url },
                { action: 'goto', url: 'https://evil.test' },
                { action: 'assertPage' },
              ],
            },
          ],
        },
        s,
        [page],
      ),
    ).toThrow('超出');
    expect(() =>
      parseModelTasks(
        {
          tasks: [
            {
              ...visual,
              steps: [
                { action: 'goto', url: page.url },
                { action: 'aiAct', instruction: '提交' },
                { action: 'assertPage' },
              ],
            },
          ],
        },
        s,
        [page],
      ),
    ).toThrow('写操作');
    expect(() =>
      parseModelTasks(
        {
          tasks: [
            {
              ...visual,
              steps: [
                { action: 'goto', url: page.url },
                { action: 'goto', url: page.url },
              ],
            },
          ],
        },
        s,
        [page],
      ),
    ).toThrow('断言');
  });
});

describe('optional planner provider contract', () => {
  it('validates the provider result, enforces failure reporting, and honors cancellation', async () => {
    const { createServer } = await import('node:http');
    const { vi } = await import('vitest');
    const { planWithModel } = await import('../server/planner.ts');
    let mode: 'ok' | 'error' = 'ok';
    let received: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received = JSON.parse(body);
      if (mode === 'error') {
        response.writeHead(429).end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ tasks: [visual] }) } }],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    vi.stubEnv('PLANNER_BASE_URL', `http://127.0.0.1:${address.port}/v1`);
    vi.stubEnv('PLANNER_API_KEY', 'test-only-placeholder');
    vi.stubEnv('PLANNER_MODEL', 'test-planner');
    vi.stubEnv('MIDSCENE_MODEL_API_KEY', 'test-only-placeholder');
    vi.stubEnv('MIDSCENE_MODEL_NAME', 'test-vision');
    vi.stubEnv('MIDSCENE_MODEL_FAMILY', 'test-family');
    try {
      const [result] = await planWithModel('检查首页', s, [page], new AbortController().signal);
      expect(result.source).toBe('model');
      expect(result.steps.at(-1)?.action).toBe('aiAssert');
      expect(received?.model).toBe('test-planner');
      expect(JSON.stringify(received)).not.toContain('test-only-placeholder');
      mode = 'error';
      await expect(
        planWithModel('检查首页', s, [page], new AbortController().signal),
      ).rejects.toThrow('HTTP 429');
      const controller = new AbortController();
      controller.abort();
      await expect(planWithModel('检查首页', s, [page], controller.signal)).rejects.toThrow();
      vi.stubEnv('PLANNER_API_KEY', '');
      expect(await planWithModel('检查首页', s, [page], new AbortController().signal)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
