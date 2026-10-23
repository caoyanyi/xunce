import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import type { Step } from '../shared/types.ts';
import { inspectLinks, matchesUrl } from '../server/assertions.ts';
import { generateTest, runTesterArmy } from '../server/tester-army.ts';
import { session, task } from './helpers.ts';

const linkPath = '/assertions/target?campaign=1#details';
const linkText = '查看 详细信息';
const relatedLinks = Array.from(
  { length: 45 },
  (_, index) => `<a href="${linkPath}">不同文字 ${index}</a>`,
).join('');
const unboundLinks = `${relatedLinks}
  <a href="/assertions/target?campaign=2#details">${linkText}</a>
  <a href="${linkPath}" hidden>${linkText}</a>`;

let server: Server | undefined;
let root: string | undefined;
let base = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'explorer-army-assertions-'));
  server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    let content: string;
    switch (pathname) {
      case '/assertions/dynamic':
        content = `${unboundLinks}<script>
          setTimeout(() => {
            const link = document.createElement('a');
            link.href = './target?campaign=1#details';
            link.textContent = '查看 \\n   详细信息';
            document.querySelector('main').append(link);
          }, 3000);
          setTimeout(() => {
            history.replaceState(null, '', '/assertions/settled/?view=actual#done');
          }, 6000);
        </script>`;
        break;
      case '/assertions/binding':
        content = unboundLinks;
        break;
      case '/assertions/static':
        content = `<p>此页面保持当前地址与可见正文</p><script>
          history.replaceState(null, '', location.pathname + location.search + '#source');
        </script>`;
        break;
      default:
        response.writeHead(404);
        response.end('not found');
        return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>断言回归</title></head>
      <body><main>断言回归固定页面 ${content}</main></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing assertion fixture address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  const active = server;
  if (active) {
    active.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      active.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (root) await rm(root, { recursive: true, force: true });
});

async function folder(name: string) {
  if (!root) throw new Error('Assertion fixtures are not initialized');
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return path;
}

function run(url: string, path: string, steps: Step[]) {
  return runTesterArmy(
    task(url, { engine: 'tester-army', steps }),
    session(url),
    path,
    new AbortController().signal,
    () => {},
  );
}

async function failure(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('Expected TesterArmy to fail the assertion');
}

async function sidecar(path: string) {
  return JSON.parse(await readFile(join(path, 'assertion-evidence.json'), 'utf8'));
}

describe('TesterArmy serialized assertion contract', () => {
  it.each([
    {
      actual: 'http://example.test/',
      expected: 'HTTP://EXAMPLE.test:80',
      match: undefined,
      result: true,
    },
    {
      actual: 'https://example.test/target?x=1#end',
      expected: 'https://EXAMPLE.test:443/a/../target?x=1#end',
      match: 'exact',
      result: true,
    },
    {
      actual: 'https://example.test/target?x=1#end',
      expected: 'https://example.test/target?x=2#end',
      match: 'exact',
      result: false,
    },
    {
      actual: 'https://example.test/target?x=1#end',
      expected: 'https://example.test/target?x=1#other',
      match: 'exact',
      result: false,
    },
    {
      actual: 'https://example.test/target?x=1#end',
      expected: 'https://example.test/target',
      match: undefined,
      result: false,
    },
    {
      actual: 'https://example.test/target/?x=1#end',
      expected: 'https://example.test/target/?x=2#other',
      match: 'path',
      result: true,
    },
    {
      actual: 'https://example.test/target/',
      expected: 'https://example.test/target',
      match: 'path',
      result: false,
    },
    {
      actual: 'https://example.test:444/target',
      expected: 'https://example.test/target',
      match: 'path',
      result: false,
    },
    {
      actual: 'https://example.test/a%2Fb',
      expected: 'https://example.test/a/b',
      match: 'path',
      result: false,
    },
  ] as const)(
    'keeps URL normalization and strict $match semantics after serialization: $expected',
    ({ actual, expected, match, result }) => {
      // No module closure is available inside the generated runner/browser context.
      const serialized = new Script(`(${matchesUrl.toString()})`).runInNewContext({
        URL,
      }) as typeof matchesUrl;
      expect(serialized(actual, expected, match)).toBe(result);
    },
  );

  it('embeds only trusted shared helpers and JSON-escaped assertion values', () => {
    const url = `${base}/assertions/static`;
    const text = "'); globalThis.__untrustedModelCode = true; //";
    const title = 'assertions "; process.exit(0); //';
    const source = generateTest(
      task(url, {
        title,
        engine: 'tester-army',
        steps: [
          { action: 'assertUrl', url, match: 'path', timeoutMs: 30000 },
          { action: 'assertLink', url, text, timeoutMs: 100 },
        ],
      }),
      session(url),
    );
    for (const helper of [matchesUrl, inspectLinks]) {
      const serialized = helper.toString();
      expect(source.includes(serialized) || source.includes(JSON.stringify(serialized))).toBe(true);
    }
    expect(source).toContain(JSON.stringify(text));
    expect(source).toContain(JSON.stringify(title));
    expect(source).not.toContain(`test('${title}'`);
  });
});

describe('TesterArmy real runner assertion regressions', () => {
  it('polls a late visible relative link beyond 40 candidates and an SPA URL without a new DOMContentLoaded', async () => {
    const url = `${base}/assertions/dynamic?view=initial`;
    const path = await folder('dynamic-pass');
    const normalized = `HTTP://127.0.0.1:${new URL(base).port}/assertions/segment/../settled/?view=actual#done`;
    const evidence = await run(url, path, [
      { action: 'goto', url },
      { action: 'assertLink', url: `${base}${linkPath}`, text: linkText, timeoutMs: 30000 },
      { action: 'assertUrl', url: normalized },
      {
        action: 'assertUrl',
        url: `${base}/assertions/settled/?view=ignored#ignored`,
        match: 'path',
      },
    ]);
    expect(evidence).toMatchObject({
      script: expect.stringContaining('task.e2e.ts'),
      report: expect.stringContaining('runner-result.json'),
      screenshot: expect.any(String),
    });
    expect(await readdir(path)).not.toContain('assertion-evidence.json');
  }, 90000);

  it('does not combine href and text from different anchors and merges the failure sidecar into UI evidence', async () => {
    const url = `${base}/assertions/binding?source=fixture`;
    const path = await folder('binding-fail');
    const assertion = {
      action: 'assertLink',
      expectedUrl: `${base}${linkPath}`,
      actualUrl: url,
      text: linkText,
      timeoutMs: 100,
      links: expect.any(Array),
      linksTruncated: true,
    };
    const expected = {
      assertion,
      failedStep: { index: 1, action: 'assertLink' },
      actualUrl: url,
      failureCode: 'link_mismatch',
    };
    const error = await failure(
      run(url, path, [
        { action: 'goto', url },
        { action: 'assertLink', url: `${base}${linkPath}`, text: linkText, timeoutMs: 100 },
      ]),
    );
    expect(error).toMatchObject({
      evidence: { ...expected, script: expect.any(String), screenshot: expect.any(String) },
    });
    const diagnostic = await sidecar(path);
    expect(diagnostic).toMatchObject(expected);
    expect(diagnostic.assertion.links).toHaveLength(40);
    expect(diagnostic.assertion.links).toContainEqual({
      text: expect.stringContaining('不同文字'),
      url: `${base}${linkPath}`,
    });
    expect(diagnostic.assertion.links).not.toContainEqual({
      text: linkText,
      url: `${base}${linkPath}`,
    });
  }, 90000);

  it('keeps query and fragment significant in exact mode and persists the actual URL and failed step', async () => {
    const url = `${base}/assertions/static?mode=actual`;
    const actualUrl = `${url}#source`;
    const expectedUrl = `${base}/assertions/static?mode=expected#destination`;
    const path = await folder('url-fail');
    const expected = {
      assertion: {
        action: 'assertUrl',
        expectedUrl,
        actualUrl,
        match: 'exact',
        timeoutMs: 100,
      },
      failedStep: { index: 1, action: 'assertUrl' },
      actualUrl,
      failureCode: 'url_mismatch',
    };
    const error = await failure(
      run(url, path, [
        { action: 'goto', url },
        { action: 'assertUrl', url: expectedUrl, timeoutMs: 100 },
      ]),
    );
    expect(error).toMatchObject({ evidence: expected });
    expect(await sidecar(path)).toMatchObject(expected);
  }, 90000);
});
