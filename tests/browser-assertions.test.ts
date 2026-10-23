import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Step } from '../shared/types.ts';
import { assertBrowserState, BrowserAssertionError } from '../server/assertions.ts';
import { browserLaunchOptions } from '../server/browser.ts';
import { executeTask } from '../server/executors.ts';
import { session, task } from './helpers.ts';

type AssertionStep = Extract<Step, { action: 'assertUrl' | 'assertLink' }>;
const targetPath = '/assertions/target?campaign=1#details';
const targetText = '查看 详细信息';
const unrelatedLinks = Array.from(
  { length: 45 },
  (_, index) => `<a href="./unrelated?index=${index}">Unrelated link ${index}</a>`,
).join('');
const unboundLinks = `${unrelatedLinks}
  <a href="./target?campaign=1#details">Different label</a>
  <a href="./target?campaign=2#details">${targetText}</a>
  <a href="./target?campaign=1#details" hidden>${targetText}</a>
  <a href="./target?campaign=1#details" style="display:none">${targetText}</a>
  <a href="./target?campaign=1#details" style="visibility:hidden">${targetText}</a>
  <div style="opacity:0"><a href="./target?campaign=1#details">${targetText}</a></div>`;

let browser: Browser;
let base: string;
let root: string;
const fixture = createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
  let content = '<p>This fixture keeps its current URL.</p>';
  if (pathname === '/assertions/spa') {
    content = `${unboundLinks}<a id="late" href="./target?campaign=1#details" hidden>查看 \n  详细信息</a>
      <script>
        setTimeout(() => { document.querySelector('#late').hidden = false; }, 600);
        setTimeout(() => {
          history.replaceState(null, '', '/assertions/settled/?view=actual#done');
        }, 6500);
      </script>`;
  } else if (pathname === '/assertions/late-link') {
    content = `${unboundLinks}<a id="late" href="./target?campaign=1#details" hidden>查看 \n  详细信息</a>`;
  } else if (pathname === '/assertions/binding') {
    content = unboundLinks;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><head><title>Browser assertions</title></head>
    <body><main>Local browser assertion fixture ${content}</main></body></html>`);
});

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Missing browser fixture address');
  base = `http://127.0.0.1:${address.port}`;
  root = await mkdtemp(join(tmpdir(), 'xunce-browser-assertions-'));
  browser = await chromium.launch(browserLaunchOptions());
});

afterAll(async () => {
  await browser?.close();
  fixture.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    fixture.close((error) => (error ? reject(error) : resolve()));
  });
  if (root) await rm(root, { recursive: true, force: true });
});

async function failure(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the browser assertion to reject');
}

function pendingStep(action: AssertionStep['action']): AssertionStep {
  return { action, url: `${base}/assertions/never`, timeoutMs: 2500 };
}

function expectInterruption(error: unknown, message: RegExp) {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(BrowserAssertionError);
  expect(error).not.toHaveProperty('failureCode', 'url_mismatch');
  expect(error).not.toHaveProperty('failureCode', 'link_mismatch');
  expect(error).toHaveProperty('message', expect.stringMatching(message));
}

async function crashPage(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const crashed = page.waitForEvent('crash', { timeout: 5000 });
  // Page.crash may never reply before teardown; the actual crash event is mandatory.
  void cdp.send('Page.crash').catch(() => {});
  await crashed;
  expect(page.isClosed()).toBe(false);
}

async function report(folder: string) {
  return JSON.parse(await readFile(join(folder, 'result.json'), 'utf8'));
}

async function expectArtifacts(folder: string) {
  for (const file of ['screenshot.png', 'trace.zip'])
    expect((await stat(join(folder, file))).size).toBeGreaterThan(0);
}

function run(
  name: string,
  url: string,
  steps: Step[],
  signal = new AbortController().signal,
  emit: (message: string) => void = () => {},
) {
  return executeTask(task(url, { steps }), session(url), name, join(root, name), signal, emit);
}

describe('assertBrowserState in real Chromium', () => {
  let context: BrowserContext;
  let page: Page;
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
  });
  afterEach(async () => {
    await context?.close();
  });

  it('uses the default 10s budget for an SPA URL change after more than 5s without another DOMContentLoaded', async () => {
    let documents = 0;
    page.on('domcontentloaded', () => documents++);
    const url = `${base}/assertions/spa?view=initial`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    expect(page.url()).toBe(url);
    const started = Date.now();
    await assertBrowserState(
      page,
      { action: 'assertUrl', url: `${base}/assertions/settled/?view=actual#done` },
      new AbortController().signal,
    );
    expect(Date.now() - started).toBeGreaterThan(5000);
    expect(page.url()).toBe(`${base}/assertions/settled/?view=actual#done`);
    expect(documents).toBe(1);
  }, 20000);

  it.each([
    {
      label: 'default exact normalizes the full URL',
      match: undefined,
      expected: 'normalized',
      pass: true,
    },
    {
      label: 'default exact retains query',
      match: undefined,
      expected: '/assertions/current/?view=other#source',
      pass: false,
    },
    {
      label: 'explicit exact retains hash',
      match: 'exact',
      expected: '/assertions/current/?view=actual#other',
      pass: false,
    },
    {
      label: 'path ignores only query and hash',
      match: 'path',
      expected: '/assertions/current/?view=other#other',
      pass: true,
    },
    {
      label: 'path retains the trailing slash',
      match: 'path',
      expected: '/assertions/current?view=actual#source',
      pass: false,
    },
    {
      label: 'path is case sensitive',
      match: 'path',
      expected: '/assertions/Current/',
      pass: false,
    },
    {
      label: 'path does not accept a child pathname',
      match: 'path',
      expected: '/assertions/current/child/',
      pass: false,
    },
    { label: 'path retains origin hostname', match: 'path', expected: 'other-host', pass: false },
    { label: 'path retains origin scheme', match: 'path', expected: 'other-scheme', pass: false },
    { label: 'path retains origin port', match: 'path', expected: 'other-port', pass: false },
  ] as const)('$label', async ({ match, expected, pass }) => {
    const actualUrl = `${base}/assertions/current/?view=actual#source`;
    await page.goto(actualUrl);
    const url =
      expected === 'normalized'
        ? `HTTP://127.0.0.1:${new URL(base).port}/assertions/child/../current/?view=actual#source`
        : expected === 'other-host'
          ? actualUrl.replace('127.0.0.1', 'localhost')
          : expected === 'other-scheme'
            ? actualUrl.replace('http:', 'https:')
            : expected === 'other-port'
              ? 'http://127.0.0.1:1/assertions/current/'
              : `${base}${expected}`;
    const pending = assertBrowserState(
      page,
      { action: 'assertUrl', url, match, timeoutMs: 150 },
      new AbortController().signal,
    );
    if (pass) {
      await expect(pending).resolves.toBeUndefined();
    } else {
      const error = await failure(pending);
      expect(error).toBeInstanceOf(BrowserAssertionError);
      expect(error).toMatchObject({
        failureCode: 'url_mismatch',
        assertion: {
          action: 'assertUrl',
          expectedUrl: new URL(url).href,
          actualUrl,
          match: match ?? 'exact',
          timeoutMs: 150,
        },
      });
    }
  });

  it('waits for a relative link to become visible beyond 40 candidates and normalizes its text', async () => {
    await page.goto(`${base}/assertions/late-link`);
    expect(await page.locator('#late').isVisible()).toBe(false);
    await page.evaluate(() => {
      setTimeout(() => {
        document.querySelector<HTMLAnchorElement>('#late')!.hidden = false;
      }, 600);
    });
    const started = Date.now();
    await assertBrowserState(
      page,
      { action: 'assertLink', url: `${base}${targetPath}`, text: targetText },
      new AbortController().signal,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(await page.locator('#late').isVisible()).toBe(true);
    expect(
      await page.locator('#late').evaluate((anchor) => (anchor as HTMLAnchorElement).href),
    ).toBe(`${base}${targetPath}`);
  });

  it('does not combine text and href from different elements or accept hidden matching links', async () => {
    const actualUrl = `${base}/assertions/binding`;
    await page.goto(actualUrl);
    const error = await failure(
      assertBrowserState(
        page,
        { action: 'assertLink', url: `${base}${targetPath}`, text: targetText, timeoutMs: 150 },
        new AbortController().signal,
      ),
    );
    expect(error).toBeInstanceOf(BrowserAssertionError);
    expect(error).toMatchObject({
      failureCode: 'link_mismatch',
      assertion: {
        action: 'assertLink',
        expectedUrl: `${base}${targetPath}`,
        actualUrl,
        text: targetText,
        timeoutMs: 150,
        linksTruncated: true,
        links: expect.arrayContaining([
          { text: 'Different label', url: `${base}${targetPath}` },
          { text: targetText, url: `${base}/assertions/target?campaign=2#details` },
        ]),
      },
    });
    const assertion = (error as BrowserAssertionError).assertion;
    expect(assertion.links).toHaveLength(40);
    expect(assertion.links).not.toContainEqual({ text: targetText, url: `${base}${targetPath}` });
  });

  it.each(['assertUrl', 'assertLink'] as const)(
    'preserves cancellation during %s polling',
    async (action) => {
      await page.goto(`${base}/assertions/static`);
      const controller = new AbortController();
      const rejected = failure(assertBrowserState(page, pendingStep(action), controller.signal));
      await delay(100);
      controller.abort();
      expectInterruption(await rejected, /操作已停止/);
    },
  );

  it.each(['assertUrl', 'assertLink'] as const)(
    'preserves page closure during %s polling',
    async (action) => {
      await page.goto(`${base}/assertions/static`);
      const rejected = failure(
        assertBrowserState(page, pendingStep(action), new AbortController().signal),
      );
      await delay(100);
      await page.close();
      expectInterruption(await rejected, /关闭|closed/i);
    },
  );

  it.each(['assertUrl', 'assertLink'] as const)(
    'preserves a real CDP Page.crash during %s polling',
    async (action) => {
      await page.goto(`${base}/assertions/static`);
      const rejected = failure(
        assertBrowserState(page, pendingStep(action), new AbortController().signal),
      );
      await delay(100);
      await crashPage(page);
      expectInterruption(await rejected, /crash|崩溃/i);
    },
  );

  it('does not pass assertUrl using a cached matching URL after the renderer has already crashed', async () => {
    const url = `${base}/assertions/static`;
    await page.goto(url);
    await crashPage(page);
    expect(page.url()).toBe(url);
    const error = await failure(
      assertBrowserState(
        page,
        { action: 'assertUrl', url, timeoutMs: 1200 },
        new AbortController().signal,
      ),
    );
    expectInterruption(error, /crash|崩溃/i);
  });
});

describe('executeTask browser assertion evidence', () => {
  it('passes a late SPA URL with the default 10s budget and writes successful browser evidence', async () => {
    const name = 'spa-pass';
    const url = `${base}/assertions/spa?view=initial`;
    const actualUrl = `${base}/assertions/settled/?view=actual#done`;
    const evidence = await run(name, url, [
      { action: 'goto', url },
      { action: 'assertLink', url: `${base}${targetPath}`, text: targetText },
      { action: 'assertUrl', url: actualUrl },
      { action: 'assertUrl', url: `${base}/assertions/settled/?ignored=1#ignored`, match: 'path' },
    ]);
    expect(evidence).toMatchObject({
      actualUrl,
      screenshot: `/artifacts/session-test/${name}/screenshot.png`,
      trace: `/artifacts/session-test/${name}/trace.zip`,
      report: `/artifacts/session-test/${name}/result.json`,
    });
    for (const key of ['failureCode', 'failedStep', 'assertion'])
      expect(evidence).not.toHaveProperty(key);
    const folder = join(root, name);
    const diagnostic = await report(folder);
    expect(diagnostic).toMatchObject({ status: 'passed', engine: 'playwright', ...evidence });
    for (const key of ['failureCode', 'failedStep', 'assertion', 'error'])
      expect(diagnostic).not.toHaveProperty(key);
    await expectArtifacts(folder);
  }, 20000);

  it('persists a normalized exact URL mismatch, actual query/hash, failed step, screenshot and trace', async () => {
    const name = 'url-fail';
    const url = `${base}/assertions/static?view=actual#source`;
    const expected = `HTTP://127.0.0.1:${new URL(base).port}/assertions/child/../static?view=expected#destination`;
    const expectedUrl = new URL(expected).href;
    const error = await failure(
      run(name, url, [
        { action: 'goto', url },
        { action: 'assertUrl', url: expected, timeoutMs: 150 },
      ]),
    );
    const evidence = {
      failureCode: 'url_mismatch',
      actualUrl: url,
      failedStep: { index: 1, action: 'assertUrl' },
      assertion: {
        action: 'assertUrl',
        expectedUrl,
        actualUrl: url,
        match: 'exact',
        timeoutMs: 150,
      },
      screenshot: `/artifacts/session-test/${name}/screenshot.png`,
      trace: `/artifacts/session-test/${name}/trace.zip`,
      report: `/artifacts/session-test/${name}/result.json`,
    };
    expect(error).toMatchObject({ failureCode: 'url_mismatch', evidence });
    const folder = join(root, name);
    expect(await report(folder)).toMatchObject({ status: 'failed', ...evidence });
    await expectArtifacts(folder);
  });

  it('persists bounded visible-link diagnostics without fabricating a text/href pair', async () => {
    const name = 'link-fail';
    const url = `${base}/assertions/binding`;
    const error = await failure(
      run(name, url, [
        { action: 'goto', url },
        { action: 'assertLink', url: `${base}${targetPath}`, text: targetText, timeoutMs: 150 },
      ]),
    );
    const evidence = {
      failureCode: 'link_mismatch',
      actualUrl: url,
      failedStep: { index: 1, action: 'assertLink' },
      assertion: {
        action: 'assertLink',
        expectedUrl: `${base}${targetPath}`,
        actualUrl: url,
        text: targetText,
        timeoutMs: 150,
        linksTruncated: true,
        links: expect.arrayContaining([
          { text: 'Different label', url: `${base}${targetPath}` },
          { text: targetText, url: `${base}/assertions/target?campaign=2#details` },
        ]),
      },
      screenshot: `/artifacts/session-test/${name}/screenshot.png`,
      trace: `/artifacts/session-test/${name}/trace.zip`,
      report: `/artifacts/session-test/${name}/result.json`,
    };
    expect(error).toMatchObject({ failureCode: 'link_mismatch', evidence });
    const folder = join(root, name);
    const diagnostic = await report(folder);
    expect(diagnostic).toMatchObject({ status: 'failed', ...evidence });
    expect(diagnostic.assertion.links).toHaveLength(40);
    expect(diagnostic.assertion.links).not.toContainEqual({
      text: targetText,
      url: `${base}${targetPath}`,
    });
    await expectArtifacts(folder);
  });

  it.each(['assertUrl', 'assertLink'] as const)(
    'does not label executeTask cancellation as a %s mismatch',
    async (action) => {
      const name = `cancel-${action}`;
      const url = `${base}/assertions/static`;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const error = await failure(
          run(
            name,
            url,
            [{ action: 'goto', url }, pendingStep(action)],
            controller.signal,
            (message) => {
              if (message.endsWith(`· ${action}`))
                timer = setTimeout(() => controller.abort(), 100);
            },
          ),
        );
        expectInterruption(error, /操作已停止/);
        expect(error).toMatchObject({
          evidence: { actualUrl: url, failedStep: { index: 1, action } },
        });
        const diagnostic = await report(join(root, name));
        expect(diagnostic).toMatchObject({
          status: 'failed',
          actualUrl: url,
          failedStep: { index: 1, action },
        });
        for (const key of ['failureCode', 'assertion']) expect(diagnostic).not.toHaveProperty(key);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  );
});
