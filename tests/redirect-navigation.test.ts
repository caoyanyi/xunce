import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrowser, browserLaunchOptions } from '../server/browser.ts';
import { launchGuardedChromium } from '../server/network-guard.ts';
import { followLink } from '../server/navigation.ts';
import { executeTask } from '../server/executors.ts';
import { session, task } from './helpers.ts';
import type { Step } from '../shared/types.ts';
import type { EventEmitter } from 'node:events';

// Playwright exposes EventEmitter methods at runtime but omits listenerCount
// from its public interfaces; keep the test-only cast at this boundary.
const listenerCount = (emitter: unknown, name: string) =>
  (emitter as Pick<EventEmitter, 'listenerCount'>).listenerCount(name);

let base = '';
let outsideBase = '';
let root = '';
const hits: string[] = [];
const outsideHits: string[] = [];
const workerRequest = `async function request(data, send) {
  try { const r = await fetch(data.url, { method: data.method }); send({status:r.status, url:r.url}); }
  catch (error) { send({error:String(error)}); }
}`;
const outside = createServer((req, res) => {
  outsideHits.push(req.url || '/');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end('outside readable content');
});
const fixture = createServer((req, res) => {
  const url = new URL(req.url || '/', base || 'http://127.0.0.1');
  hits.push(`${req.method} ${url.pathname}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/hop1') res.writeHead(302, { location: '/hop2' }).end();
  else if (url.pathname === '/hop2')
    res.writeHead(307, { location: '/final?canonical=1#terms' }).end();
  else if (url.pathname === '/to-error') res.writeHead(302, { location: '/error' }).end();
  else if (url.pathname === '/to-cut') res.writeHead(302, { location: '/cut' }).end();
  else if (url.pathname === '/unsafe-hop') res.writeHead(302, { location: '/delete' }).end();
  else if (url.pathname === '/to-outside')
    res.writeHead(302, { location: outsideBase + '/forbidden' }).end();
  else if (url.pathname === '/error')
    res.writeHead(503).end('<title>Unavailable</title><h1>Final document unavailable</h1>');
  else if (url.pathname === '/cut') {
    res.writeHead(200, { 'content-length': '4096' });
    res.write('<title>Incomplete</title><h1>Incomplete response</h1>');
    const timer = setTimeout(() => res.destroy(), 100);
    res.on('close', () => clearTimeout(timer));
  } else if (url.pathname === '/dedicated.js' || url.pathname === '/shared.js') {
    res.setHeader('content-type', 'application/javascript');
    res.end(
      workerRequest +
        (url.pathname === '/dedicated.js'
          ? 'self.onmessage = e => request(e.data, value => self.postMessage(value));'
          : 'self.onconnect = e => { const p = e.ports[0]; p.onmessage = e => request(e.data, value => p.postMessage(value)); p.start(); };'),
    );
  } else if (url.pathname === '/index') {
    const target = url.searchParams.get('popup') === '1' ? ' target="_blank"' : '';
    res.end(`<title>Link fixture</title><h1>Approved navigation</h1>
      ${['hop1', 'to-error', 'to-cut', 'unsafe-hop', 'to-outside'].map((path) => `<a href="/${path}"${target}>${path}</a>`).join('')}
      <a href="#section">hash</a><div id="section">section</div>`);
  } else if (url.pathname === '/army-resources') {
    res.end(`<title>Resource guard</title><h1>Safe resource page</h1><script>
      Promise.all([
        fetch('/unsafe-hop').catch(() => {}),
        fetch('/write', {method:'POST'}).catch(() => {}),
        fetch('/to-outside').catch(() => {}),
        fetch('${outsideBase}/direct').catch(() => {}),
      ]).then(() => { const p = document.createElement('p'); p.textContent = 'guard requests finished'; document.body.append(p); });
    </script>`);
  } else res.end('<title>Final document</title><h1>Canonical terms of service</h1>');
});
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'explorer-redirect-'));
  await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
  outsideBase = `http://127.0.0.1:${(outside.address() as { port: number }).port}`;
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
});
afterAll(async () => {
  await Promise.all(
    [fixture, outside].map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }),
  );
  if (root) await rm(root, { recursive: true, force: true });
});
async function run(
  name: string,
  url: string,
  steps: Step[],
  engine: 'playwright' | 'tester-army' = 'playwright',
) {
  const folder = join(root, name);
  await mkdir(folder, { recursive: true });
  return executeTask(
    task(url, { steps, engine }),
    session(url),
    name,
    folder,
    new AbortController().signal,
    () => {},
  );
}

describe('redirect-aware link navigation', () => {
  it.each([false, true])(
    'follows legitimate multi-hop redirects once (popup=%s) and removes listeners',
    async (popup) => {
      hits.length = 0;
      await withBrowser(base, false, new AbortController().signal, async (context) => {
        const page = await context.newPage();
        await page.goto(`${base}/index?popup=${Number(popup)}`);
        const before = ['request', 'response', 'requestfailed', 'close'].map((name) =>
          listenerCount(context, name),
        );
        const result = await followLink(page, `${base}/hop1`);
        expect(result.status).toBe(200);
        expect(result.page.url()).toBe(`${base}/final?canonical=1#terms`);
        expect(result.page === page).toBe(!popup);
        expect(
          ['request', 'response', 'requestfailed', 'close'].map((name) =>
            listenerCount(context, name),
          ),
        ).toEqual(before);
        expect(listenerCount(page, 'popup')).toBe(0);
        expect(listenerCount(result.page, 'framenavigated')).toBe(0);
      });
      for (const path of ['/hop1', '/hop2', '/final'])
        expect(hits.filter((hit) => hit === `GET ${path}`)).toHaveLength(1);
    },
  );

  it.each(['empty-target', 'named-self', 'named-existing'] as const)(
    'respects the browser target for %s navigation',
    async (kind) => {
      await withBrowser(base, false, new AbortController().signal, async (context) => {
        const page = await context.newPage();
        await page.goto(`${base}/index`);
        let destination = page;
        if (kind === 'named-existing') {
          const opened = page.waitForEvent('popup');
          await page.evaluate(() => {
            window.open('/index', 'docs');
          });
          destination = await opened;
          await destination.waitForLoadState('domcontentloaded');
        }
        if (kind !== 'empty-target')
          await destination.evaluate(() => {
            window.name = 'docs';
          });
        const href = kind === 'empty-target' ? `${base}/final` : `${base}/index#section`;
        await page.evaluate(
          ({ kind, href }) => {
            const base = document.createElement('base');
            base.target = '_blank';
            document.head.append(base);
            const link = document.createElement('a');
            link.href = href;
            link.target = kind === 'empty-target' ? '' : 'docs';
            link.textContent = 'Open approved document';
            document.body.replaceChildren(link);
          },
          { kind, href },
        );
        const result = await followLink(page, href);
        if (kind === 'empty-target') expect(result.page).not.toBe(page);
        else expect(result.page).toBe(destination);
        expect(result.page.url()).toBe(href);
        // Chromium inherits <base target> when the link target is empty.
        expect(context.pages()).toHaveLength(kind === 'named-self' ? 1 : 2);
        expect(listenerCount(destination, 'framenavigated')).toBe(0);
      });
    },
  );

  it('does not weaken assertUrl to match the pre-redirect href', async () => {
    const url = `${base}/index?popup=1`;
    await expect(
      run('strict-url', url, [
        { action: 'goto', url },
        { action: 'navigateLink', url: `${base}/hop1` },
        { action: 'assertUrl', url: `${base}/hop1`, timeoutMs: 100 },
      ]),
    ).rejects.toMatchObject({
      evidence: {
        actualUrl: `${base}/final?canonical=1#terms`,
        failureCode: 'url_mismatch',
        failedStep: { index: 2, action: 'assertUrl' },
      },
    });
  });

  it.each([false, true])(
    'blocks dangerous GET and cross-origin redirect hops before I/O (popup=%s)',
    async (popup) => {
      hits.length = 0;
      outsideHits.length = 0;
      await withBrowser(base, false, new AbortController().signal, async (context) => {
        for (const path of ['/unsafe-hop', '/to-outside']) {
          const page = await context.newPage();
          await page.goto(`${base}/index?popup=${Number(popup)}`);
          await expect(followLink(page, base + path)).rejects.toThrow(/链接导航失败|ERR_/);
        }
      });
      expect(hits).not.toContain('GET /delete');
      expect(outsideHits).toEqual([]);
      expect(hits.filter((hit) => hit === 'GET /unsafe-hop')).toHaveLength(1);
      expect(hits.filter((hit) => hit === 'GET /to-outside')).toHaveLength(1);
    },
  );

  it('keeps final HTTP failure and incomplete-response evidence on the popup, without retrying', async () => {
    for (const [path, name, finalPath, message] of [
      ['/to-error', 'http-error', '/error', /HTTP 503/],
      ['/to-cut', 'transport-error', '/cut', /ERR_|Incomplete|closed|链接导航失败/],
    ] as const) {
      hits.length = 0;
      const url = `${base}/index?popup=1`;
      await expect(
        run(name, url, [
          { action: 'goto', url },
          { action: 'navigateLink', url: base + path },
        ]),
      ).rejects.toMatchObject({
        message: expect.stringMatching(message),
        evidence: {
          actualUrl: base + finalPath,
          screenshot: expect.any(String),
          trace: expect.any(String),
          failedStep: { index: 1, action: 'navigateLink' },
        },
      });
      const report = JSON.parse(await readFile(join(root, name, 'result.json'), 'utf8'));
      expect(report.status).toBe('failed');
      expect(hits.filter((hit) => hit === `GET ${path}`)).toHaveLength(1);
    }
  });

  it('handles same-document links, but never substitutes a source hash change or unrelated popup', async () => {
    await withBrowser(base, false, new AbortController().signal, async (context) => {
      const page = await context.newPage();
      await page.goto(`${base}/index`);
      expect((await followLink(page, `${base}/index#section`)).page).toBe(page);
      await page.goto(`${base}/index?popup=1`);
      await page.locator('a[href="/hop1"]').evaluate((element) => {
        element.addEventListener('click', () => {
          location.hash = 'source-only';
          window.open('/unrelated', '_blank');
        });
      });
      const result = await followLink(page, `${base}/hop1`);
      expect(page.url()).toContain('#source-only');
      expect(result.page.url()).toBe(`${base}/final?canonical=1#terms`);
      expect(result.page).not.toBe(page);
    });
  });
});

describe('browser-wide per-hop read-only interception', () => {
  it.each(['dedicated', 'shared'])(
    'guards %s worker requests without disabling safe worker reads',
    async (kind) => {
      hits.length = 0;
      const guarded = await launchGuardedChromium(browserLaunchOptions(), base, false, true);
      try {
        const page = await guarded.browser.newPage();
        await page.goto(`${base}/index`);
        const results = await page.evaluate(
          async ({ kind, outsideBase }) => {
            const worker =
              kind === 'dedicated' ? new Worker('/dedicated.js') : new SharedWorker('/shared.js');
            const port = worker instanceof Worker ? worker : worker.port;
            if (port instanceof MessagePort) port.start();
            const results = [];
            for (const [url, method] of [
              ['/read', 'GET'],
              ['/write', 'POST'],
              ['/unsafe-hop', 'GET'],
              ['/to-outside', 'GET'],
              [outsideBase + '/worker-direct', 'GET'],
              ['/hop1', 'GET'],
            ]) {
              results.push(
                await new Promise((resolve) => {
                  port.onmessage = (event) => resolve(event.data);
                  port.postMessage({ url, method });
                }),
              );
            }
            if (worker instanceof Worker) worker.terminate();
            else worker.port.close();
            return results;
          },
          { kind, outsideBase },
        );
        expect(results[0]).toMatchObject({ status: 200 });
        for (const result of results.slice(1, 5)) expect(result).toHaveProperty('error');
        expect(results[5]).toMatchObject({ status: 200, url: `${base}/final?canonical=1` });
        expect(hits).not.toContain('GET /delete');
        expect(hits).not.toContain('POST /write');
        expect(guarded.browser.isConnected()).toBe(true);
      } finally {
        await guarded.close();
      }
    },
  );

  it('preserves TesterArmy all-resource same-origin and read-only policy in its child process', async () => {
    hits.length = 0;
    outsideHits.length = 0;
    const url = `${base}/army-resources`;
    await run(
      'army-resources',
      url,
      [
        { action: 'goto', url },
        { action: 'assertText', text: 'guard requests finished' },
      ],
      'tester-army',
    );
    expect(hits).not.toContain('GET /delete');
    expect(hits).not.toContain('POST /write');
    expect(outsideHits).toEqual([]);
  }, 90000);

  it('allows safe redirects in TesterArmy but blocks an unsafe main-document redirect', async () => {
    const url = `${base}/hop1`;
    await run(
      'army-safe-redirect',
      url,
      [
        { action: 'goto', url },
        { action: 'assertUrl', url: `${base}/final?canonical=1#terms` },
      ],
      'tester-army',
    );
    hits.length = 0;
    const unsafe = `${base}/unsafe-hop`;
    await expect(
      run('army-unsafe-redirect', unsafe, [{ action: 'goto', url: unsafe }], 'tester-army'),
    ).rejects.toThrow();
    expect(hits).not.toContain('GET /delete');
  }, 90000);
});
