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
  it('chooses a truthful Playwright fallback for TesterArmy-incompatible LAN HTTP targets', () => {
    const lan = session('http://192.168.1.28:9999/');
    lan.options.engine = 'tester-army';
    const [first] = tasksFromPages(lan, [{ ...page, url: lan.targetUrl }]);
    expect(first.engine).toBe('playwright');
    expect(first.engineNote).toContain('兼容');
  });
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
    expect(task.steps.at(-1)).toMatchObject({ action: 'assertUrl', url: page.url });
    expect(task.engine).toBe('playwright');
  });
  it('accepts assertLink as the only outcome and preserves its text and timeout', () => {
    const link = {
      action: 'assertLink',
      url: new URL('/terms?version=2#legal', page.url).href,
      text: '服务 条款',
      timeoutMs: 2500,
    };
    const [task] = parseModelTasks(
      { tasks: [{ ...visual, steps: [{ action: 'goto', url: page.url }, link] }] },
      s,
      [page],
    );
    expect(task.steps.at(-1)).toEqual(link);
    expect(task.engine).toBe('playwright');
    expect(task.risk).toBe('read');
  });
  it.each(['exact', 'path'] as const)(
    'preserves an explicit assertUrl %s match, timeout and complete expected URL',
    (match) => {
      const assertion = {
        action: 'assertUrl',
        url: new URL('/home?next=%2Fconsole#overview', page.url).href,
        match,
        timeoutMs: 15000,
      };
      const [task] = parseModelTasks(
        { tasks: [{ ...visual, steps: [{ action: 'goto', url: page.url }, assertion] }] },
        s,
        [page],
      );
      expect(task.steps.at(-1)).toEqual(assertion);
      expect(task.engine).toBe('playwright');
    },
  );
  it('uses Playwright for entirely deterministic model tasks even when Midscene is preferred', () => {
    const preferredVisual = session();
    preferredVisual.options.engine = 'midscene';
    const [task] = parseModelTasks(
      {
        tasks: [
          {
            ...visual,
            steps: [
              { action: 'goto', url: page.url },
              { action: 'assertPage' },
              { action: 'assertText', text: 'hello' },
              { action: 'assertUrl', url: page.url },
              { action: 'assertLink', url: new URL('/terms', page.url).href },
            ],
          },
        ],
      },
      preferredVisual,
      [page],
    );
    expect(task.engine).toBe('playwright');
    expect(task.source).toBe('model');
  });
  it.each(['aiAct', 'aiAssert'] as const)(
    'keeps Midscene and the original instruction when a task contains %s',
    (action) => {
      const writable = session();
      writable.options.allowWrites = true;
      const aiStep = {
        action,
        instruction:
          action === 'aiAct' ? '填写登录表单并提交' : '登录页品牌与表单布局协调，错误提示清晰可见',
      };
      const [task] = parseModelTasks(
        {
          tasks: [
            {
              ...visual,
              steps: [
                { action: 'goto', url: page.url },
                aiStep,
                { action: 'assertUrl', url: page.url },
              ],
            },
          ],
        },
        writable,
        [page],
      );
      expect(task.engine).toBe('midscene');
      expect(task.steps).toHaveLength(3);
      expect(task.steps[1]).toEqual(aiStep);
      expect(task.risk).toBe(action === 'aiAct' ? 'write' : 'read');
    },
  );
  it.each([
    '验证服务条款链接及地址 http://127.0.0.1:4318/terms?version=2#legal',
    '确认当前 URL 为 http://127.0.0.1:4318/login?next=%2Fconsole#form',
    '检查登录页地址是否正确',
    '检查浏览器地址',
    '检查服务条款链接的 href 属性',
    '服务条款链接的 href 应为 /terms?version=2#legal',
    '检查服务条款链接的目标地址',
    '确认服务条款链接指向用户指定的目标',
    '验证目标链接是否符合预期',
    'Verify the current URL equals http://127.0.0.1:4318/login',
    'Check the browser address',
    'The terms link href must be /terms?version=2#legal',
    'Verify the link destination matches the expected address',
    'The terms link should point to the supplied destination',
  ])(
    'rejects an explicit address aiAssert without inferring its expectation: %s',
    (instruction) => {
      const raw = {
        tasks: [
          {
            ...visual,
            steps: [
              { action: 'goto', url: page.url },
              { action: 'aiAssert', instruction },
            ],
          },
        ],
      };
      const before = structuredClone(raw);
      expect(() => parseModelTasks(raw, s, [page])).toThrow(/assertUrl.*assertLink/);
      expect(raw).toEqual(before);
    },
  );
  it('rejects an address aiAssert even when a deterministic assertion is also present', () => {
    expect(() =>
      parseModelTasks(
        {
          tasks: [
            {
              ...visual,
              steps: [
                { action: 'goto', url: page.url },
                { action: 'assertUrl', url: page.url },
                { action: 'aiAssert', instruction: '确认服务条款链接的 href 为 /terms' },
              ],
            },
          ],
        },
        s,
        [page],
      ),
    ).toThrow(/assertUrl.*assertLink/);
  });
  it.each([
    '登录页布局完整，品牌标识清晰可见',
    '登录失败后错误提示醒目且没有遮挡表单',
    '服务条款链接与登录按钮对齐且样式一致',
    '登录后呈现正确的页面和品牌导航',
    'URL 输入框的标签与错误提示没有重叠',
    'URL 格式错误提示清晰可见',
    'href 属性说明文字与示例代码可读',
    '地址栏图标与页面品牌配色一致',
    '页面展示网址 http://127.0.0.1:4318/terms 的说明文案且排版清晰',
    'The URL field and its validation message are aligned',
    'The terms link is visible and its label is readable',
  ])('preserves a genuinely visual aiAssert without guessing an address: %s', (instruction) => {
    const aiStep = { action: 'aiAssert', instruction };
    const steps = [{ action: 'goto', url: page.url }, aiStep];
    const [task] = parseModelTasks({ tasks: [{ ...visual, steps }] }, s, [page]);
    expect(task.steps).toEqual(steps);
    expect(task.engine).toBe('midscene');
    expect(task.risk).toBe('read');
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
    let modelTask = visual;
    let requests = 0;
    let received: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      requests += 1;
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
          choices: [{ message: { content: JSON.stringify({ tasks: [modelTask] }) } }],
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
      const observedPage: Observation = {
        ...page,
        actualUrl: new URL('/login?returnTo=%2Fconsole#form', page.url).href,
        links: [{ text: '服务条款', url: new URL('/terms?version=2#legal', page.url).href }],
      };
      const [result] = await planWithModel(
        '检查首页',
        s,
        [observedPage],
        new AbortController().signal,
        ['之前提供的测试账号：qa@example.test'],
      );
      expect(result.source).toBe('model');
      expect(result.engine).toBe('midscene');
      expect(result.steps.at(-1)?.action).toBe('aiAssert');
      expect(requests).toBe(1);
      expect(received?.model).toBe('test-planner');
      const messages = received?.messages as { role: string; content: string }[];
      const goal = JSON.parse(messages.find((message) => message.role === 'user')!.content);
      expect(goal.previousUserMessages).toContain('qa@example.test');
      expect(goal.intent).toBe('检查首页');
      expect(goal.pages[0].url).toBe(page.url);
      expect(goal.pages[0].actualUrl).toBe(observedPage.actualUrl);
      expect(goal.pages[0].links).toEqual(observedPage.links);
      const prompt = messages.find((message) => message.role === 'system')!.content;
      expect(prompt).toContain('isolated browser');
      expect(prompt).toContain(
        'Allowed actions: goto, aiAct, aiAssert, assertText, assertPage, assertUrl, assertLink.',
      );
      expect(prompt).toContain(
        'do not add aiAssert when deterministic steps fully express the goal',
      );
      expect(prompt).toContain('match is optional and defaults to exact');
      expect(prompt).toContain('exact compares the full canonical URL including query and hash');
      expect(prompt).toContain('match:"path" compares only origin and pathname');
      expect(prompt).toContain('ignoring query and hash');
      expect(prompt).toContain("only when the user's expectation explicitly permits that scope");
      expect(prompt).toContain('never by default or to hide an incorrect address');
      expect(prompt).toContain('defaults to 10000');
      expect(prompt).toContain('integer from 100 to 30000');
      expect(prompt).toContain('visible a element without clicking');
      expect(prompt).toContain('canonical href must exactly match url');
      expect(prompt).toContain(
        "whitespace-normalized substring of that same anchor's visible text",
      );
      expect(prompt).toContain('"text":"服务条款"');
      expect(prompt).toContain('Use assertText or assertLink for link-text presence');
      expect(prompt).toContain(
        'Never delegate href or destination URL checks to visual assertions',
      );
      expect(prompt).toContain('aiAssert to infer invisible attributes');
      expect(prompt).toContain(
        'Ground strict browser URL expectations in observed actualUrl or explicit user-provided expectations',
      );
      expect(prompt).toContain('Never invent or rewrite an expected address');
      expect(prompt).toContain('observed actualUrl, not the entry address when it redirects');
      expect(JSON.stringify(received)).not.toContain('test-only-placeholder');

      vi.stubEnv('MIDSCENE_MODEL_API_KEY', '');
      vi.stubEnv('MIDSCENE_MODEL_NAME', '');
      vi.stubEnv('MIDSCENE_MODEL_FAMILY', '');
      const urlAssertion = {
        action: 'assertUrl',
        url: observedPage.actualUrl!,
        match: 'exact',
        timeoutMs: 12000,
      };
      const linkAssertion = {
        action: 'assertLink',
        url: observedPage.links[0].url,
        text: '服务条款',
        timeoutMs: 2000,
      };
      modelTask = {
        ...visual,
        steps: [{ action: 'goto', url: page.url }, urlAssertion, linkAssertion],
      };
      const [deterministic] = await planWithModel(
        '检查登录页地址与服务条款链接',
        s,
        [observedPage],
        new AbortController().signal,
      );
      expect(deterministic.engine).toBe('playwright');
      expect(deterministic.steps).toEqual(modelTask.steps);
      expect(requests).toBe(2);
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
