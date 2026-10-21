import { spawn } from 'node:child_process';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, basename } from 'node:path';
import type { RunResult } from 'e2e/runner';
import type { Session, Task } from '../shared/types.ts';
import { resolveChromiumPath } from './browser.ts';
import { throwIfAborted } from './policy.ts';

export function generateTest(task: Task, session: Session): string {
  // Only validated JSON values are interpolated. All executable code is this fixed template.
  return `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
const steps = ${JSON.stringify(task.steps, null, 2)};
const origin = ${JSON.stringify(new URL(session.targetUrl).origin)};
const allowWrites = ${JSON.stringify(session.options.allowWrites)};
test(${JSON.stringify(task.title)}, async ({ app, browser, screen }) => {
  await browser.goto('about:blank');
  await browser.route('**/*', async route => {
    const request = route.request;
    if (new URL(request.url).origin !== origin || (!allowWrites && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))) return route.abort();
    return route.continue();
  });
  try {
    for (const step of steps) {
      switch (step.action) {
        case 'goto': {
          const [response] = await Promise.all([browser.waitForResponse(step.url), browser.goto(step.url, { waitUntil: 'domcontentloaded' })]);
          const finalStatus = await browser.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming & { responseStatus: number })?.responseStatus || 0);
          const status = Math.max(response.status, finalStatus);
          if (status >= 400) throw new Error('HTTP ' + status + ': ' + step.url);
          break;
        }
        case 'assertPage': {
          const content = await browser.evaluate(() => ({ title: document.title, text: document.body.innerText.trim() }));
          if (!content.title.trim()) throw new Error('页面标题为空');
          if (content.text.length < 5) throw new Error('页面正文为空或内容不足');
          await expect(browser.locator('body')).toBeVisible();
          break;
        }
        case 'assertText': await expect(screen.getByText(step.text)).toBeVisible(); break;
        case 'assertUrl': if (await browser.url() !== step.url) throw new Error('页面 URL 不匹配'); break;
        case 'assertLink': await expect(browser.locator('a[href=' + JSON.stringify(step.url) + ']')).toBeVisible(); break;
        default: throw new Error('TesterArmy 适配器不支持此步骤：' + step.action);
      }
    }
  } finally { await app.screenshot('result'); }
});
`;
}
export async function findArtifactFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await findArtifactFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
export async function runTesterArmy(
  task: Task,
  session: Session,
  folder: string,
  signal: AbortSignal,
  emit: (message: string) => void,
) {
  throwIfAborted(signal);
  const script = generateTest(task, session);
  await writeFile(join(folder, 'task.e2e.ts'), script);
  const runtime = script
    .replace("from '@e2e-dev/web'", `from ${JSON.stringify(import.meta.resolve('@e2e-dev/web'))}`)
    .replace("from 'e2e'", `from ${JSON.stringify(import.meta.resolve('e2e'))}`);
  await writeFile(join(folder, 'runtime.e2e.ts'), runtime);
  // The official runner executes the fixed test template in an isolated process. No shell is involved.
  const runner = `import { run } from ${JSON.stringify(import.meta.resolve('e2e/runner'))};
import { web } from ${JSON.stringify(import.meta.resolve('@e2e-dev/web'))};
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { chromium } from ${JSON.stringify(import.meta.resolve('playwright'))};
let hostBrowser;
let webOptions = {};
if (process.env.CHROMIUM_PATH) {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  hostBrowser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port] });
  webOptions = { connect: { cdpEndpoint: () => 'http://127.0.0.1:' + port } };
}
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
try {
const result = await run({ cwd: ${JSON.stringify(folder)}, config: {
  targets: [{ name: 'chromium', engine: web(webOptions), app: { url: ${JSON.stringify(new URL(session.targetUrl).origin)} } }],
  tests: ['runtime.e2e.ts'], output: 'output', timeout: 30000, launchTimeout: 25000, cleanupTimeout: 5000,
  workers: 1, retries: 0, trace: 'on', cache: 'off', reporters: []
}, interruptSignal: controller.signal });
await writeFile(${JSON.stringify(join(folder, 'runner-result.json'))}, JSON.stringify(result));
process.exitCode = result.exitCode;
} finally { await hostBrowser?.close(); }
`;
  await writeFile(join(folder, 'runner.mjs'), runner);
  emit('已生成结构化测试，启动 TesterArmy 官方 runner');
  const log: string[] = [];
  const exitCode = await new Promise<number | null>((done, reject) => {
    const child = spawn(process.execPath, [join(folder, 'runner.mjs')], {
      cwd: resolve('.'),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        CHROMIUM_PATH: resolveChromiumPath(),
        E2E_TELEMETRY_DISABLED: '1',
        NO_COLOR: '1',
      },
    });
    const stop = (force = false) => {
      if (!child.pid) return;
      try {
        process.kill(
          process.platform === 'win32' ? child.pid : -child.pid,
          force ? 'SIGKILL' : 'SIGTERM',
        );
      } catch {
        /* already stopped */
      }
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      stop();
      killTimer = setTimeout(() => stop(true), 2000);
    };
    const timeout = setTimeout(cancel, 60000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const capture = (chunk: Buffer) => {
      if (log.join('').length < 64000) log.push(chunk.toString());
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', cancel);
    };
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      done(code);
    });
  });
  await writeFile(join(folder, 'runner.log'), log.join(''));
  const files = await findArtifactFiles(folder);
  const url = (path: string) =>
    `/artifacts/${session.id}/${basename(folder)}/${relative(folder, path).split('\\').join('/')}`;
  const screenshot = files.find((f) => f.endsWith('.png'));
  const trace = files.find((f) => f.endsWith('.zip')) || files.find((f) => f.endsWith('trace.md'));
  const evidence = {
    script: url(join(folder, 'task.e2e.ts')),
    report: url(
      join(
        folder,
        files.includes(join(folder, 'runner-result.json')) ? 'runner-result.json' : 'runner.log',
      ),
    ),
    ...(screenshot ? { screenshot: url(screenshot) } : {}),
    ...(trace ? { trace: url(trace) } : {}),
  };
  let result: Partial<RunResult> = {};
  try {
    result = JSON.parse(await readFile(join(folder, 'runner-result.json'), 'utf8'));
  } catch {
    /* child may have been interrupted */
  }
  if (exitCode !== 0 || result.status !== 'passed') {
    const errors = result.report?.run;
    const detail =
      errors?.errors?.map((e) => e.message).join('\n') ||
      errors?.results
        ?.flatMap((r) => r.attempts.flatMap((a) => [a.error, ...a.secondaryErrors]))
        .filter((e) => e !== undefined)
        .map((e) => e.message)
        .join('\n');
    const error = new Error(
      signal.aborted
        ? '操作已停止'
        : detail ||
            `TesterArmy 执行${result.status || '失败'}（退出码 ${exitCode}）\n${log.join('').slice(-2500)}`,
    );
    throw Object.assign(error, { evidence });
  }
  emit('TesterArmy 已完成测试与断言');
  return evidence;
}
