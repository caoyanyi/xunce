import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { browserLaunchOptions } from '../server/browser.ts';
import { PageReadiness } from '../server/page-readiness.ts';
import { discover } from '../server/discovery.ts';
import { executeTask } from '../server/executors.ts';
import { session, task } from './helpers.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let browser: Browser;
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/delayed')
    res.end(
      `<title>Delayed SPA</title><div id="app"></div><aside>Chat widget is ready</aside><script>setTimeout(() => { history.replaceState({}, '', '/platform'); document.querySelector('#app').innerHTML='<label>Account<input name="account"></label><label>Password<input type="password"></label><button>Log in</button>'; }, 900);</script>`,
    );
  else if (req.url === '/loading') res.end('<title>Loading</title><div id="root">Loading...</div>');
  else res.end('<title>Broken</title><div id="app"></div>');
});
let base: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch(browserLaunchOptions());
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
describe('application rendering readiness', () => {
  it('uses the rendered SPA for discovery and execution and records its redirected address', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'xunce-render-'));
    try {
      const url = `${base}/delayed`;
      const s = session(url);
      s.options.maxPages = 1;
      const [page] = await discover(s, folder, new AbortController().signal, () => {});
      expect(page.url).toBe(url);
      expect(page.actualUrl).toBe(`${base}/platform`);
      expect(page.inputs?.some((input) => input.type === 'password')).toBe(true);
      const evidence = await executeTask(
        task(url),
        s,
        'rendered',
        folder,
        new AbortController().signal,
        () => {},
      );
      expect(evidence.actualUrl).toBe(`${base}/platform`);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  it('waits past DOMContentLoaded and a chat widget for delayed SPA rendering and redirect', async () => {
    const page = await browser.newPage();
    const readiness = new PageReadiness(page, base);
    try {
      await page.goto(`${base}/delayed`, { waitUntil: 'domcontentloaded' });
      expect(await page.locator('input').count()).toBe(0);
      await readiness.wait(new AbortController().signal, 3000);
      expect(page.url()).toBe(`${base}/platform`);
      expect(await page.locator('input:visible').count()).toBe(2);
    } finally {
      readiness.close();
      await page.close();
    }
  });
  it('also waits for the delayed application in the official TesterArmy adapter', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'xunce-army-render-'));
    try {
      const url = `${base}/delayed`;
      const evidence = await executeTask(
        task(url, { engine: 'tester-army' }),
        session(url),
        'army-rendered',
        folder,
        new AbortController().signal,
        () => {},
      );
      expect(evidence.screenshot).toBeTruthy();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 90000);
  it.each(['/loading', '/blank'])(
    'reports %s as not rendered instead of sending a blank screenshot to the model',
    async (path) => {
      const page = await browser.newPage();
      const readiness = new PageReadiness(page, base);
      try {
        await page.goto(base + path);
        await expect(readiness.wait(new AbortController().signal, 600)).rejects.toMatchObject({
          failureCode: 'page_not_ready',
        });
      } finally {
        readiness.close();
        await page.close();
      }
    },
  );
  it('forwards cancellation while waiting for an empty application', async () => {
    const page = await browser.newPage();
    const readiness = new PageReadiness(page, base);
    try {
      await page.goto(`${base}/blank`);
      const controller = new AbortController();
      const waiting = readiness.wait(controller.signal);
      controller.abort();
      await expect(waiting).rejects.toBeDefined();
    } finally {
      readiness.close();
      await page.close();
    }
  });
});
