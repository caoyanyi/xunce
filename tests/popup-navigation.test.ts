import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { testApp, task } from './helpers.ts';

let env: Awaited<ReturnType<typeof testApp>>;
let base: string;
let outsideBase: string;
let outsideVisits = 0;
let slowVisits = 0;
const outside = createServer((_req, res) => {
  outsideVisits++;
  res.end('<title>Outside</title>outside');
});
const fixture = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/slow') {
    slowVisits++;
    res.write('<title>Loading terms</title>');
    const timer = setTimeout(() => res.end('<h1>Slow terms</h1>'), 1000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (req.url === '/destination' || req.url === '/same-destination')
    res.end('<title>Terms</title><h1>Terms of Service</h1>');
  else if (req.url === '/broken') {
    res.statusCode = 500;
    res.end('<title>Unavailable</title><h1>Temporary failure</h1>');
  } else
    res.end(
      `<title>Login</title><h1>Login page</h1><a href="/destination" target="_blank" rel="noopener">Terms</a><a href="/same-destination">Same tab</a><a href="/broken" target="_blank">Broken terms</a><a href="/slow" target="_blank">Slow terms</a><a href="${outsideBase}/" target="_blank">Outside</a>`,
    );
});
beforeAll(async () => {
  env = await testApp();
  await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
  outsideBase = `http://127.0.0.1:${(outside.address() as { port: number }).port}`;
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
});
afterAll(async () => {
  await env?.app.close();
  await Promise.all(
    [fixture, outside].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  if (env) await rm(env.dir, { recursive: true, force: true });
});

function browserChild(destination: string) {
  const source = `import { withBrowser } from './server/browser.ts';
await withBrowser(${JSON.stringify(base)}, false, AbortSignal.timeout(10000), async context => {
 const page = await context.newPage(); await page.goto(${JSON.stringify(base)});
 const resultPromise = ${JSON.stringify(destination)} === 'Terms' ? page.waitForEvent('popup') : context.waitForEvent('requestfailed', {predicate: request => request.url().startsWith(${JSON.stringify(outsideBase)})});
 await page.getByRole('link', {name: ${JSON.stringify(destination)}, exact: true}).click();
 const popup = await resultPromise;
 if (${JSON.stringify(destination)} === 'Terms') { await popup.waitForLoadState('domcontentloaded'); if (!(await popup.title()).includes('Terms')) throw new Error('Popup did not load'); }
 console.log('browser-process-survived');
});`;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
describe('popup request and navigation lifecycle', () => {
  it('does not terminate the server process when a popup navigation has no frame yet', async () => {
    const result = await browserChild('Terms');
    expect(result.stderr).not.toContain('Frame for this navigation request is not available');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('browser-process-survived');
  });
  it('still blocks an outside-origin popup without crashing the process', async () => {
    outsideVisits = 0;
    const result = await browserChild('Outside');
    expect(result.code).toBe(0);
    expect(outsideVisits).toBe(0);
  });
  it('follows the new tab for assertions, preserves failure evidence, and continues with the next task', async () => {
    const s = env.store.createSession(base, { engine: 'playwright' });
    for (const destination of ['/destination', '/same-destination', '/broken']) {
      env.store.put(
        'tasks',
        task(base, {
          id: randomUUID(),
          sessionId: s.id,
          kind: 'navigation',
          steps: [
            { action: 'goto', url: base },
            { action: 'navigateLink', url: base + destination },
            { action: 'assertPage' },
          ],
        }),
      );
    }
    env.store.put('tasks', task(base, { id: randomUUID(), sessionId: s.id }));
    env.orchestrator.start(s.id, 'run');
    await env.orchestrator.waitForIdle();
    const snapshot = env.store.snapshot(s.id)!;
    expect(snapshot.runs.map((run) => run.status)).toEqual([
      'passed',
      'passed',
      'failed',
      'passed',
    ]);
    expect(snapshot.runs[0].actualUrl).toBe(`${base}/destination`);
    expect(snapshot.runs[1].actualUrl).toBe(`${base}/same-destination`);
    expect(snapshot.runs[2].actualUrl).toBe(`${base}/broken`);
    expect(snapshot.runs[2].error).toContain('HTTP 500');
    expect(snapshot.runs[2].screenshot).toBeTruthy();
    env.orchestrator.start(s.id, 'run', '', [snapshot.tasks[0].id]);
    await env.orchestrator.waitForIdle();
    expect(env.store.list('runs', s.id)).toHaveLength(5);
    expect(env.store.list('runs', s.id).at(-1)?.status).toBe('passed');
    expect((await env.app.inject('/api/health')).statusCode).toBe(200);
    expect(env.orchestrator.isBusy()).toBe(false);
  });
  it('can cancel during popup loading and start a new task without a rejected route or stale worker', async () => {
    const s = env.store.createSession(base, { engine: 'playwright' });
    const slow = env.store.put(
      'tasks',
      task(base, {
        id: randomUUID(),
        sessionId: s.id,
        steps: [
          { action: 'goto', url: base },
          { action: 'navigateLink', url: `${base}/slow` },
          { action: 'assertPage' },
        ],
      }),
    );
    slowVisits = 0;
    env.orchestrator.start(s.id, 'run', '', [slow.id]);
    await expect.poll(() => slowVisits, { timeout: 15000, interval: 25 }).toBe(1);
    env.orchestrator.cancel(s.id);
    await env.orchestrator.waitForIdle();
    expect(env.store.list('runs', s.id)[0].status).toBe('cancelled');
    const next = env.store.put('tasks', task(base, { id: randomUUID(), sessionId: s.id }));
    env.orchestrator.start(s.id, 'run', '', [next.id]);
    await env.orchestrator.waitForIdle();
    expect(env.store.list('runs', s.id).at(-1)?.status).toBe('passed');
    expect((await env.app.inject('/api/health')).statusCode).toBe(200);
  });
});
