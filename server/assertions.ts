import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import type { Run, Step } from '../shared/types.ts';
import { throwIfAborted } from './policy.ts';

// Self-contained functions: also serialized into the fixed TesterArmy template.
export function matchesUrl(actual: string, expected: string, match: 'exact' | 'path' = 'exact') {
  try {
    const left = new URL(actual);
    const right = new URL(expected);
    return match === 'path'
      ? left.origin === right.origin && left.pathname === right.pathname
      : left.href === right.href;
  } catch {
    return false;
  }
}

export function inspectLinks(expected?: { url: string; text?: string }) {
  // Keep normalization inline: tsx's keep-names transform wraps local function
  // declarations in __name(), which is unavailable when serialized to the browser.
  const expectedUrl = expected ? new URL(expected.url).href : undefined;
  const expectedText = expected?.text ? expected.text.replace(/\s+/g, ' ').trim() : undefined;
  const candidates: { text: string; url: string; relevant: boolean }[] = [];
  let matched = false;
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!anchor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const text = anchor.innerText.replace(/\s+/g, ' ').trim();
    const url = anchor.href;
    const hrefMatches = url === expectedUrl;
    const textMatches = expectedText !== undefined && text.includes(expectedText);
    if (hrefMatches && (expectedText === undefined || textMatches)) matched = true;
    candidates.push({
      text: text.slice(0, 500),
      url: url.slice(0, 4096),
      relevant: hrefMatches || textMatches,
    });
  }
  // Evidence is bounded, but matching above examines every visible anchor.
  candidates.sort((a, b) => Number(b.relevant) - Number(a.relevant));
  return {
    matched,
    links: candidates.slice(0, 40).map(({ text, url }) => ({ text, url })),
    truncated: candidates.length > 40,
  };
}

export class BrowserAssertionError extends Error {
  readonly failureCode: 'url_mismatch' | 'link_mismatch';
  constructor(public assertion: NonNullable<Run['assertion']>) {
    const kind = assertion.action === 'assertUrl' ? '页面 URL 不匹配' : '可见链接未满足断言';
    super(
      `${kind}（等待 ${assertion.timeoutMs}ms）。预期：${assertion.expectedUrl}；实际页面：${assertion.actualUrl}${assertion.text ? `；同一链接文本需包含：${assertion.text}` : ''}`,
    );
    this.failureCode = assertion.action === 'assertUrl' ? 'url_mismatch' : 'link_mismatch';
  }
}

export async function assertBrowserState(
  page: Page,
  step: Extract<Step, { action: 'assertUrl' | 'assertLink' }>,
  signal: AbortSignal,
) {
  const timeoutMs = step.timeoutMs ?? 10000;
  const deadline = Date.now() + timeoutMs;
  let links: ReturnType<typeof inspectLinks> | undefined;
  while (true) {
    throwIfAborted(signal);
    if (page.isClosed()) throw new Error('断言执行已中断：浏览器页面已关闭');
    try {
      // Read from the renderer, not Playwright's cached page.url(): a crashed page
      // must never pass (or be reported as an ordinary expectation mismatch).
      const state =
        step.action === 'assertUrl'
          ? await page.evaluate(() => location.href)
          : await page.evaluate(inspectLinks, { url: step.url, text: step.text });
      throwIfAborted(signal);
      if (typeof state === 'string') {
        if (step.action === 'assertUrl' && matchesUrl(state, step.url, step.match)) return;
      } else {
        links = state;
        if (links.matched) return;
      }
    } catch (error) {
      throwIfAborted(signal);
      if (page.isClosed()) throw new Error('断言执行已中断：浏览器页面已关闭', { cause: error });
      // Only document replacement is transient; closed/crashed renderers are errors.
      if (!(error instanceof Error) || !/Execution context was destroyed/i.test(error.message))
        throw error;
      links = undefined;
    }
    if (Date.now() >= deadline) {
      throw new BrowserAssertionError({
        action: step.action,
        expectedUrl: new URL(step.url).href,
        actualUrl: page.url(),
        timeoutMs,
        ...(step.action === 'assertUrl'
          ? { match: step.match ?? 'exact' }
          : {
              text: step.text,
              links: links?.links,
              linksTruncated: links?.truncated,
            }),
      });
    }
    try {
      await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
  }
}
