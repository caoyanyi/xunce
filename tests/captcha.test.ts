import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rm, readFile } from 'node:fs/promises';
import { testApp, task } from './helpers.ts';
import { startCaptchaFixture } from './captcha-fixture.ts';
import type { Run, Step } from '../shared/types.ts';

let env: Awaited<ReturnType<typeof testApp>>;
let fixture: Awaited<ReturnType<typeof startCaptchaFixture>>;
beforeAll(async () => {
  env = await testApp();
  fixture = await startCaptchaFixture();
});
afterAll(async () => {
  await env?.app.close();
  await fixture?.close();
  if (env) await rm(env.dir, { recursive: true, force: true });
});
function start(extraSteps: Step[] = []) {
  const url = `${fixture.base}/login`;
  const session = env.store.createSession(url, { engine: 'playwright', allowWrites: true });
  env.store.put(
    'tasks',
    task(url, {
      id: randomUUID(),
      sessionId: session.id,
      risk: 'write',
      kind: 'form',
      steps: [
        { action: 'goto', url },
        { action: 'fill', selector: '[name=email]', value: 'qa@example.test' },
        { action: 'fill', selector: '[name=password]', value: 'fixture-password' },
        { action: 'click', selector: 'button[type=submit]' },
        { action: 'assertUrl', url: `${fixture.base}/home` },
        { action: 'assertText', text: '登录成功' },
        ...extraSteps,
      ],
    }),
  );
  env.orchestrator.start(session.id, 'run');
  return session.id;
}
async function waiting(id: string, attempt = 1): Promise<Run> {
  await expect
    .poll(() => env.store.list('runs', id)[0]?.pendingInput?.attempt, { timeout: 20000 })
    .toBe(attempt);
  return env.store.list('runs', id)[0];
}
function submit(id: string, run: Run, value: string, requestId = run.pendingInput!.id) {
  return env.app.inject({
    method: 'POST',
    url: `/api/sessions/${id}/runs/${run.id}/input`,
    payload: { requestId, value },
  });
}
describe('live CAPTCHA handoff', () => {
  it('retains the exact login page, credentials, nonce and cookies through wrong-code retry, then verifies the same run', async () => {
    const visits = fixture.visits();
    const id = start();
    const first = await waiting(id);
    expect(env.store.get('sessions', id)?.status).toBe('waiting_input');
    expect(env.store.list('tasks', id)[0].status).toBe('waiting_input');
    expect(env.orchestrator.isBusy()).toBe(true);
    const snapshot = (await env.app.inject(`/api/sessions/${id}`)).json();
    expect(snapshot.runs[0].pendingInput.id).toBe(first.pendingInput!.id);
    expect(
      (await env.app.inject(first.pendingInput!.screenshot)).headers['content-type'],
    ).toContain('image/png');
    expect((await submit(id, first, '')).statusCode).toBe(400);
    const other = env.store.createSession(`${fixture.base}/login`);
    expect((await submit(other.id, first, 'Q7K9')).statusCode).toBe(409);
    expect((await submit(id, first, 'WRONG')).statusCode).toBe(202);
    expect((await submit(id, first, 'Q7K9')).statusCode).toBe(409);
    const second = await waiting(id, 2);
    expect(second.id).toBe(first.id);
    expect(second.pendingInput!.id).not.toBe(first.pendingInput!.id);
    expect((await submit(id, second, 'Q7K9', first.pendingInput!.id)).statusCode).toBe(409);
    expect((await submit(id, second, 'Q7K9')).statusCode).toBe(202);
    await env.orchestrator.waitForIdle();
    const result = env.store.snapshot(id)!;
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ status: 'passed', actualUrl: `${fixture.base}/home` });
    expect(result.runs[0].pendingInput).toBeUndefined();
    expect(result.runs[0].failureCode).toBeUndefined();
    expect(fixture.visits()).toBe(visits + 1);
    expect(fixture.submissions.slice(-2)).toEqual(
      ['WRONG', 'Q7K9'].map((captcha) => ({
        email: 'qa@example.test',
        password: 'fixture-password',
        captcha,
        nonce: 'same-page-nonce',
        cookie: 'qa=live-context',
      })),
    );
    expect(JSON.stringify(result)).not.toContain('Q7K9');
    expect(JSON.stringify(result)).not.toContain('WRONG');
    expect(
      await readFile(`${env.dir}/artifacts/${id}/${first.id}/result.json`, 'utf8'),
    ).not.toContain('Q7K9');
  });
  it('cancels waiting input, rejects its old request and frees the worker', async () => {
    const id = start();
    const run = await waiting(id);
    await env.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, payload: {} });
    await env.orchestrator.waitForIdle();
    expect(env.store.snapshot(id)!.runs[0]).toMatchObject({ status: 'cancelled' });
    expect(env.store.snapshot(id)!.runs[0].pendingInput).toBeUndefined();
    expect(env.orchestrator.isBusy()).toBe(false);
    expect((await submit(id, run, 'Q7K9')).statusCode).toBe(409);
  });
  it('keeps an unrelated post-login assertion failure distinct from CAPTCHA failure', async () => {
    const id = start([{ action: 'assertUrl', url: `${fixture.base}/missing` }]);
    const run = await waiting(id);
    expect((await submit(id, run, 'Q7K9')).statusCode).toBe(202);
    await env.orchestrator.waitForIdle();
    const result = env.store.snapshot(id)!.runs[0];
    expect(result.status).toBe('failed');
    expect(result.actualUrl).toBe(`${fixture.base}/home`);
    expect(result.failureCode).toBe('url_mismatch');
    expect(result.failedStep).toEqual({ index: 6, action: 'assertUrl' });
    expect(result.assertion).toMatchObject({
      action: 'assertUrl',
      expectedUrl: `${fixture.base}/missing`,
      actualUrl: `${fixture.base}/home`,
      match: 'exact',
    });
    expect(result.error).not.toContain('Q7K9');
    expect(JSON.stringify(env.store.snapshot(id))).not.toContain('Q7K9');
    expect(
      await readFile(`${env.dir}/artifacts/${id}/${run.id}/result.json`, 'utf8'),
    ).not.toContain('Q7K9');
  });
  it('ends after three unsuccessful human submissions without claiming login passed', async () => {
    const id = start();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const run = await waiting(id, attempt);
      expect((await submit(id, run, 'WRONG')).statusCode).toBe(202);
    }
    await env.orchestrator.waitForIdle();
    const run = env.store.snapshot(id)!.runs[0];
    expect(run.status).toBe('failed');
    expect(run.error).toContain('3 次上限');
    expect(run.pendingInput).toBeUndefined();
  });
});
