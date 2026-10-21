import type { Page, Request } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

export function renderingFingerprint(): string {
  const root =
    document.querySelector<HTMLElement>('#app, #root, [data-reactroot]') || document.body;
  if (!root || document.readyState === 'loading') return '';
  const text = root.innerText.trim();
  if (/^(?:loading|please wait|加载中|正在加载|请稍候)[\s.…!]*$/i.test(text)) return '';
  const visible = Array.from(
    root.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]),button,a,select,textarea,img,canvas,svg,[role="button"]',
    ),
  ).filter((element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  if (text.length < 5 && !visible.length) return '';
  // No field values: only layout/content metadata is needed for this readiness gate.
  return JSON.stringify([
    location.href,
    text.slice(0, 2000),
    visible.map((element) => [
      element.tagName,
      element.getAttribute('placeholder'),
      element.getAttribute('aria-label'),
    ]),
  ]);
}

export class PageReadiness {
  private pending = new Set<Request>();
  private activity = Date.now();
  private resourceFailures = 0;
  private scriptErrors = 0;
  private origin: string;
  constructor(
    private page: Page,
    target: string,
  ) {
    this.origin = new URL(target).origin;
    page.on('request', this.request);
    page.on('requestfinished', this.finished);
    page.on('requestfailed', this.failed);
    page.on('pageerror', this.pageError);
  }
  private request = (request: Request) => {
    if (
      new URL(request.url()).origin === this.origin &&
      ['document', 'script', 'stylesheet'].includes(request.resourceType())
    ) {
      this.pending.add(request);
      this.activity = Date.now();
    }
  };
  private finished = (request: Request) => {
    if (this.pending.delete(request)) this.activity = Date.now();
  };
  private failed = (request: Request) => {
    if (this.pending.has(request)) this.resourceFailures++;
    this.finished(request);
  };
  private pageError = () => {
    this.scriptErrors++;
  };
  async wait(signal: AbortSignal, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let previous = '';
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (this.page.isClosed()) throw new Error('等待渲染时浏览器页面已关闭');
      const state = await this.page.evaluate(renderingFingerprint).catch(() => ''); // A SPA may replace the document during its initial redirect.
      if (state !== previous || !state || this.pending.size) stableSince = Date.now();
      if (state && !this.pending.size && Date.now() - Math.max(stableSince, this.activity) >= 400)
        return;
      previous = state;
      await delay(100, undefined, { signal });
    }
    throw Object.assign(
      new Error(
        `页面在 ${timeoutMs / 1000} 秒内未完成渲染：应用仍为空白、持续加载或关键资源未就绪。实际 URL：${this.page.url()}；待加载资源 ${this.pending.size} 个，资源失败 ${this.resourceFailures} 个，脚本错误 ${this.scriptErrors} 条。已停止后续操作与视觉断言，请检查页面加载和跳转。`,
      ),
      { failureCode: 'page_not_ready' },
    );
  }
  close() {
    this.page.off('request', this.request);
    this.page.off('requestfinished', this.finished);
    this.page.off('requestfailed', this.failed);
    this.page.off('pageerror', this.pageError);
  }
}
