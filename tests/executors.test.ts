import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTask } from '../server/executors.ts';
import { generateTest } from '../server/tester-army.ts';
import { testApp, session, task } from './helpers.ts';
let env: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  env = await testApp();
});
afterAll(async () => {
  await env?.app.close();
  if (env) await rm(env.dir, { recursive: true, force: true });
});
const emit = () => {};
describe('execution adapters', () => {
  it('runs Playwright assertions and preserves screenshot and trace', async () => {
    const url = `${env.base}/demo`;
    const s = session(url);
    const evidence = await executeTask(
      task(url),
      s,
      'pw-pass',
      `${env.dir}/artifacts/${s.id}/pw-pass`,
      new AbortController().signal,
      emit,
    );
    expect(evidence.screenshot).toContain('screenshot.png');
    expect((await stat(`${env.dir}/artifacts/${s.id}/pw-pass/trace.zip`)).size).toBeGreaterThan(0);
    await expect(
      executeTask(
        task(`${env.base}/demo/sale`),
        s,
        'pw-fail',
        `${env.dir}/artifacts/${s.id}/pw-fail`,
        new AbortController().signal,
        emit,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 500'),
      evidence: { screenshot: expect.stringContaining('screenshot.png') },
    });
  });
  it('validates actual empty form constraints without submitting', async () => {
    const url = `${env.base}/demo/login`;
    const s = session(url);
    await expect(
      executeTask(
        task(url, {
          kind: 'form',
          steps: [
            { action: 'goto', url },
            { action: 'validateForm', index: 0 },
          ],
        }),
        s,
        'form',
        `${env.dir}/artifacts/${s.id}/form`,
        new AbortController().signal,
        emit,
      ),
    ).resolves.toHaveProperty('trace');
  });
  it('does not silently pass an unconfigured visual engine', async () => {
    vi.stubEnv('MIDSCENE_MODEL_API_KEY', '');
    try {
      const url = `${env.base}/demo`;
      await expect(
        executeTask(
          task(url, { engine: 'midscene' }),
          session(url),
          'visual',
          `${env.dir}/artifacts/visual`,
          new AbortController().signal,
          emit,
        ),
      ).rejects.toThrow('尚未配置');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('escapes hostile titles and values as JSON in a fixed code template', () => {
    const url = `${env.base}/demo`;
    const title = "test'); process.exit(0); //";
    const source = generateTest(task(url, { title }), session(url));
    expect(source).toContain(`test(${JSON.stringify(title)},`);
    expect(source).not.toContain(`test('${title}'`);
  });
  it('runs the real TesterArmy runner successfully without model keys', async () => {
    const url = `${env.base}/demo`;
    const s = session(url);
    const external = await mkdtemp(join(tmpdir(), 'explorer-external-'));
    try {
      const evidence = await executeTask(
        task(url, { engine: 'tester-army' }),
        s,
        'army-pass',
        external,
        new AbortController().signal,
        emit,
      );
      expect(evidence.script).toContain('task.e2e.ts');
      expect(evidence.report).toContain('runner-result.json');
      expect(evidence.screenshot).toBeTruthy();
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  }, 90000);
  it('reports an actual TesterArmy assertion failure with evidence', async () => {
    const url = `${env.base}/demo/sale`;
    const s = session(url);
    await expect(
      executeTask(
        task(url, { engine: 'tester-army' }),
        s,
        'army-fail',
        `${env.dir}/artifacts/${s.id}/army-fail`,
        new AbortController().signal,
        emit,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 500'),
      evidence: { script: expect.stringContaining('task.e2e.ts'), screenshot: expect.any(String) },
    });
  }, 90000);
});
