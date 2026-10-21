import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Observation, Session, Task } from '../shared/types.ts';
import { now } from '../shared/types.ts';
import { withBrowser } from './browser.ts';
import {
  errorMessage,
  inScope,
  isSafeNavigation,
  throwIfAborted,
  testerArmyCompatible,
} from './policy.ts';
import { PageReadiness } from './page-readiness.ts';

export async function discover(
  session: Session,
  artifactsDir: string,
  signal: AbortSignal,
  onPage: (page: Observation) => void,
): Promise<Observation[]> {
  const folder = join(artifactsDir, session.id);
  await mkdir(folder, { recursive: true });
  return withBrowser(session.targetUrl, false, signal, async (context) => {
    const pages: Observation[] = [];
    const queue = [{ url: session.targetUrl, depth: 0 }];
    const seen = new Set<string>();
    const page = await context.newPage();
    const readiness = new PageReadiness(page, session.targetUrl);
    while (queue.length && pages.length < session.options.maxPages) {
      throwIfAborted(signal);
      const next = queue.shift()!;
      if (seen.has(next.url)) continue;
      seen.add(next.url);
      const result: Observation = {
        id: randomUUID(),
        sessionId: session.id,
        ...next,
        title: '',
        status: 0,
        links: [],
        forms: [],
        text: '',
      };
      try {
        const response = await page.goto(next.url, { waitUntil: 'domcontentloaded' });
        result.status = response?.status() ?? 200;
        if (result.status < 400) await readiness.wait(signal);
        result.actualUrl = page.url();
        const dom = await page.evaluate(() => ({
          title: document.title,
          text: (document.querySelector('main') ?? document.body).innerText.slice(0, 6000),
          links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
            .slice(0, 100)
            .map((a) => ({
              text: (a.innerText || a.getAttribute('aria-label') || a.href).trim().slice(0, 100),
              url: a.href,
            })),
          forms: Array.from(document.forms)
            .slice(0, 15)
            .map((form, index) => ({
              index,
              name: form.getAttribute('aria-label') || form.id || `表单 ${index + 1}`,
              required: form.querySelectorAll('[required]:not([disabled]):not([type="hidden"])')
                .length,
            })),
          inputs: Array.from(
            document.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])'),
          )
            .filter((input) => input.getClientRects().length > 0)
            .slice(0, 30)
            .map((input) => ({
              label: (
                input.getAttribute('aria-label') ||
                Array.from(input.labels || [])
                  .map((label) => label.textContent)
                  .join(' ')
                  .trim() ||
                input.placeholder ||
                input.name
              ).slice(0, 150),
              type: input.type,
              required: input.required || input.getAttribute('aria-required') === 'true',
            })),
        }));
        Object.assign(result, dom);
        result.links = result.links
          .filter((link) => inScope(link.url, session.targetUrl) && isSafeNavigation(link.url))
          .map((link) => {
            const url = new URL(link.url);
            url.hash = '';
            return { ...link, url: url.href };
          });
        if (result.status >= 400) result.error = `HTTP ${result.status}`;
        if (next.depth < session.options.maxDepth) {
          for (const link of result.links)
            if (!seen.has(link.url) && !queue.some((q) => q.url === link.url))
              queue.push({ url: link.url, depth: next.depth + 1 });
        }
        const filename = `page-${result.id}.png`;
        await page.screenshot({ path: join(folder, filename), fullPage: false });
        result.screenshot = `/artifacts/${session.id}/${filename}`;
      } catch (error) {
        throwIfAborted(signal);
        result.error = errorMessage(error).slice(0, 1000);
      }
      pages.push(result);
      onPage(result);
    }
    readiness.close();
    return pages;
  });
}

export function tasksFromPages(session: Session, pages: Observation[]): Task[] {
  const tasks: Task[] = [];
  for (const page of pages) {
    const compatible = session.options.engine !== 'tester-army' || testerArmyCompatible(page.url);
    const base = {
      sessionId: session.id,
      url: page.url,
      source: 'dom' as const,
      engine:
        session.options.engine === 'midscene' || !compatible
          ? ('playwright' as const)
          : session.options.engine,
      engineNote: !compatible
        ? '该 HTTP 目标使用 Playwright 兼容执行；TesterArmy 上游仅支持 HTTPS 或 loopback HTTP。'
        : undefined,
      risk: 'read' as const,
      status: 'pending' as const,
      createdAt: now(),
    };
    tasks.push({
      ...base,
      id: randomUUID(),
      title: `${page.depth === 0 ? '首页' : page.title || new URL(page.url).pathname} · 页面可用性`,
      description: '验证 HTTP 响应、页面标题与正文内容，发现错误页和空白页。',
      kind: 'smoke',
      priority: page.depth === 0 ? 'P0' : 'P1',
      steps: [{ action: 'goto', url: page.url }, { action: 'assertPage' }],
    });
    for (const form of page.forms.filter((f) => f.required > 0)) {
      tasks.push({
        ...base,
        id: randomUUID(),
        engine: 'playwright',
        title: `${form.name} · 必填校验`,
        description: `已发现 ${form.required} 个必填字段；检查空值能否触发浏览器约束，不提交表单。`,
        kind: 'form',
        priority: 'P1',
        steps: [
          { action: 'goto', url: page.url },
          { action: 'validateForm', index: form.index },
        ],
      });
    }
  }
  // Verify an actual navigation affordance, rather than inferring a workflow from a URL alone.
  const entry = pages[0];
  const link = entry?.links.find(
    (item) => item.url !== entry.url && pages.some((p) => p.url === item.url && p.status < 400),
  );
  if (entry && link)
    tasks.push({
      id: randomUUID(),
      sessionId: session.id,
      url: entry.url,
      source: 'dom',
      engine: 'playwright',
      risk: 'read',
      status: 'pending',
      createdAt: now(),
      title: `导航 · ${link.text}`,
      description: '检查入口链接存在且可见，实际点击链接并验证目标页面。',
      kind: 'navigation',
      priority: 'P1',
      steps: [
        { action: 'goto', url: entry.url },
        { action: 'navigateLink', url: link.url },
        { action: 'assertPage' },
      ],
    });
  return tasks;
}
