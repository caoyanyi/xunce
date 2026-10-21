import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { executeTask } from '../server/executors.ts';
import { testApp, session, task } from './helpers.ts';

// Exercise the real browser/report lifecycle while replacing only the paid visual-model boundary.
vi.mock('@midscene/web/playwright', () => ({
  PlaywrightAgent: class {
    reportFile?: string;
    constructor(private page: Page) {}
    async aiAct(_instruction: string, options: { abortSignal: AbortSignal }) {
      options.abortSignal.throwIfAborted();
      await this.page.getByLabel('邮箱').fill('qa@example.test');
    }
    async aiAssert(instruction: string, _message: unknown, options: { abortSignal: AbortSignal }) {
      options.abortSignal.throwIfAborted();
      if (instruction === 'force-fail') throw new Error('视觉断言未满足');
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
