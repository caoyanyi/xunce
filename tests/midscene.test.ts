import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { executeTask } from '../server/executors.ts';
import { testApp, session, task } from './helpers.ts';
import { startCaptchaFixture } from './captcha-fixture.ts';

const actions = vi.hoisted(() => ({ manual: 0 }));

// Exercise the real browser/report lifecycle while replacing only the paid visual-model boundary.
vi.mock('@midscene/web/playwright', () => ({
  PlaywrightAgent: class {
    reportFile?: string;
    constructor(private page: Page) {}
    async aiAct(_instruction: string, options: { abortSignal: AbortSignal }) {
      options.abortSignal.throwIfAborted();
      await this.page.getByLabel('邮箱').fill('qa@example.test');
      if (_instruction === 'login-with-human-code') {
        actions.manual++;
        await this.page.getByLabel('密码', { exact: true }).fill('fixture-password');
        await this.page.getByRole('button', { name: 'Log in' }).click();
        throw new Error('Login requires human CAPTCHA input');
      }
      if (_instruction === 'trigger-captcha') {
        await this.page.evaluate(() => {
          const field = document.createElement('input');
          field.placeholder = 'Enter image code';
          field.setAttribute('aria-label', 'Enter image code');
          field.setAttribute('aria-invalid', 'true');
          document.forms[0].append(field);
        });
      }
    }
    async aiAssert(
      instruction: string,
      _message: unknown,
      options: { abortSignal: AbortSignal; context?: string },
    ) {
      options.abortSignal.throwIfAborted();
      if (instruction === 'check-popup-document') {
        expect(await this.page.title()).toBe('Popup terms');
        expect(options.context).toContain(this.page.url());
        return;
      }
      if (instruction === 'login-succeeded') {
        await this.page.getByRole('heading', { name: '登录成功 · 首页' }).waitFor();
        expect(options.context).not.toContain('Q7K9');
        return;
      }
      if (instruction === 'force-fail') throw new Error('视觉断言未满足');
      if (instruction === 'check-browser-url') {
        expect(options.context).toContain(this.page.url());
        return;
      }
      if (instruction === 'captcha-validation-visible') {
        expect(await this.page.getByLabel('Enter image code').inputValue()).toBe('');
        return;
      }
      expect(await this.page.getByLabel('邮箱').inputValue()).toBe('qa@example.test');
    }
    async destroy() {
      const { getMidsceneRunDir } = await import('@midscene/shared/common');
      this.reportFile = join(getMidsceneRunDir(), 'report.html');
      await writeFile(this.reportFile, '<!doctype html><title>Visual contract report</title>');
    }
  },
}));
let env: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  env = await testApp();
  vi.stubEnv('MIDSCENE_MODEL_API_KEY', 'test-only-placeholder');
  vi.stubEnv('MIDSCENE_MODEL_NAME', 'test-model');
  vi.stubEnv('MIDSCENE_MODEL_FAMILY', 'test-family');
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await env?.app.close();
  if (env) await rm(env.dir, { recursive: true, force: true });
});
describe('Midscene SDK contract (model mocked)', () => {
  it('binds subsequent visual assertions to a navigated popup instead of the source tab', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(
        req.url === '/destination'
          ? '<title>Popup terms</title><h1>Terms content</h1>'
          : '<title>Popup source</title><a href="/destination" target="_blank">Terms</a>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/source`;
    const destination = new URL('/destination', url).href;
    const s = session(url);
    try {
      const evidence = await executeTask(
        task(url, {
          engine: 'midscene',
          steps: [
            { action: 'goto', url },
            { action: 'aiAssert', instruction: 'check-browser-url' },
            { action: 'navigateLink', url: destination },
            { action: 'aiAssert', instruction: 'check-popup-document' },
          ],
        }),
        s,
        'visual-popup',
        `${env.dir}/artifacts/${s.id}/visual-popup`,
        new AbortController().signal,
        () => {},
      );
      expect(evidence.actualUrl).toBe(destination);
      expect(evidence.report).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('hands a blocked visual action to a human without replaying the credential action', async () => {
    const fixture = await startCaptchaFixture();
    try {
      const url = `${fixture.base}/login`;
      const s = session(url);
      s.options.allowWrites = true;
      const evidence = await executeTask(
        task(url, {
          engine: 'midscene',
          risk: 'write',
          steps: [
            { action: 'goto', url },
            { action: 'aiAct', instruction: 'login-with-human-code' },
            { action: 'assertUrl', url: `${fixture.base}/home` },
            { action: 'aiAssert', instruction: 'login-succeeded' },
          ],
        }),
        s,
        'manual-visual',
        `${env.dir}/artifacts/${s.id}/manual-visual`,
        new AbortController().signal,
        () => {},
        async (challenge) => {
          expect(challenge.attempt).toBe(1);
          expect(challenge.actualUrl).toBe(url);
          return 'Q7K9';
        },
      );
      expect(actions.manual).toBe(1);
      expect(evidence.actualUrl).toBe(`${fixture.base}/home`);
      expect(evidence.failureCode).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
  it('supplies the actual browser URL to visual assertions and preserves it as evidence', async () => {
    const url = `${env.base}/demo/login`;
    const s = session(url);
    const evidence = await executeTask(
      task(url, {
        engine: 'midscene',
        steps: [
          { action: 'goto', url },
          { action: 'aiAssert', instruction: 'check-browser-url' },
        ],
      }),
      s,
      'url-facts',
      `${env.dir}/artifacts/${s.id}/url-facts`,
      new AbortController().signal,
      () => {},
    );
    expect(evidence).toMatchObject({ actualUrl: url });
  });
  it('identifies an unmet image CAPTCHA prerequisite without hiding the failed assertion', async () => {
    const url = `${env.base}/demo/login`;
    const s = session(url);
    s.options.allowWrites = true;
    await expect(
      executeTask(
        task(url, {
          engine: 'midscene',
          steps: [
            { action: 'goto', url },
            { action: 'aiAct', instruction: 'trigger-captcha' },
            { action: 'aiAssert', instruction: 'force-fail' },
          ],
        }),
        s,
        'captcha-fail',
        `${env.dir}/artifacts/${s.id}/captcha-fail`,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({
      failureCode: 'captcha_required',
      message: expect.stringContaining('验证码'),
      evidence: { actualUrl: url, screenshot: expect.any(String) },
    });
  });
  it('allows a successful assertion about CAPTCHA validation feedback', async () => {
    const url = `${env.base}/demo/login`;
    const s = session(url);
    s.options.allowWrites = true;
    await expect(
      executeTask(
        task(url, {
          engine: 'midscene',
          steps: [
            { action: 'goto', url },
            { action: 'aiAct', instruction: 'trigger-captcha' },
            { action: 'aiAssert', instruction: 'captcha-validation-visible' },
          ],
        }),
        s,
        'captcha-expected',
        `${env.dir}/artifacts/${s.id}/captcha-expected`,
        new AbortController().signal,
        () => {},
        async () => {
          throw new Error('验证验证码必填提示不应请求人工输入');
        },
      ),
    ).resolves.toHaveProperty('screenshot');
  });
  it('delegates actions and assertions with cancellation signals and preserves a portable report', async () => {
    const url = `${env.base}/demo/login`;
    const s = session(url);
    s.options.allowWrites = true;
    const steps = [
      { action: 'goto' as const, url },
      { action: 'aiAct' as const, instruction: '填写测试邮箱' },
      { action: 'aiAssert' as const, instruction: '邮箱已填写' },
    ];
    const folder = `${env.dir}/artifacts/${s.id}/visual-pass`;
    const evidence = await executeTask(
      task(url, { engine: 'midscene', risk: 'write', steps }),
      s,
      'visual-pass',
      folder,
      new AbortController().signal,
      () => {},
    );
    expect(evidence.screenshot).toContain('screenshot.png');
    expect(evidence.report).toContain('report.html');
    expect(await readFile(`${folder}/report.html`, 'utf8')).toContain('Visual contract report');
    const { getMidsceneRunDir } = await import('@midscene/shared/common');
    expect(getMidsceneRunDir()).not.toContain('visual-pass');
  });
  it('preserves evidence and fails when the visual SDK rejects an assertion', async () => {
    const url = `${env.base}/demo/login`;
    const s = session(url);
    await expect(
      executeTask(
        task(url, {
          engine: 'midscene',
          steps: [
            { action: 'goto', url },
            { action: 'aiAssert', instruction: 'force-fail' },
          ],
        }),
        s,
        'visual-fail',
        `${env.dir}/artifacts/${s.id}/visual-fail`,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({
      message: '视觉断言未满足',
      evidence: { screenshot: expect.any(String), report: expect.stringContaining('report.html') },
    });
  });
  it('propagates cancellation during an active visual task', async () => {
    const url = `${env.base}/demo/login`;
    const s = session(url);
    s.options.allowWrites = true;
    const controller = new AbortController();
    const pending = executeTask(
      task(url, {
        engine: 'midscene',
        steps: [
          { action: 'goto', url },
          { action: 'aiAct', instruction: '填写邮箱' },
        ],
      }),
      s,
      'visual-stop',
      `${env.dir}/artifacts/${s.id}/visual-stop`,
      controller.signal,
      (message) => {
        if (message.includes('aiAct')) controller.abort();
      },
    );
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(controller.signal.aborted).toBe(true);
  });
});
